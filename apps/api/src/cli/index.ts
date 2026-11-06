import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '@agentbazaar/config';
import { CreateAgentClientInput, Password } from '@agentbazaar/contracts';
import { z } from 'zod';
import { createApp, type RunningApp } from '../bootstrap/create-app.js';
import { createDatabase, MIGRATIONS_DIR } from '../bootstrap/infra.js';
import { AccountService, AgentClientService } from '../modules/identity/index.js';
import { SearchIndexer } from '../modules/search/index.js';
import { generateKeyEnv } from '../shared/crypto/keyring.js';
import { loadMigrations, migrate } from '../shared/db/migrator.js';
import { piiRewrap } from './pii-rewrap.js';
import { seedDemo } from './seed.js';

const USAGE = `Usage: pnpm --filter @agentbazaar/api cli <command> [options]

  migrate                                      Apply pending database migrations
  seed [--products 300] [--admin-email E] [--admin-password P]
                                               Demo catalog, GST rates, an MFA admin and a demo agent client
  reindex                                      Rebuild the search index
  keys                                         Print fresh secrets as .env lines
  create-admin --email E --password P [--name N]
  create-agent-client --name N [--scopes "catalog:read quote:create order:create"] [--quota 60]
  pii rewrap [--batch-size 100]                Move customer data keys from PII_MASTER_KEY to OpenBao Transit
                                               (lite to growth), and re-wrap them after a Transit key rotation`;

const OPTIONS = {
  products: { type: 'string' },
  'admin-email': { type: 'string' },
  'admin-password': { type: 'string' },
  email: { type: 'string' },
  password: { type: 'string' },
  name: { type: 'string' },
  scopes: { type: 'string' },
  quota: { type: 'string' },
  'batch-size': { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];

const otpauth = (secret: string) => `otpauth://totp/AgentBazaar:admin?secret=${secret}&issuer=AgentBazaar`;

async function withApp(fn: (running: RunningApp) => Promise<void>): Promise<void> {
  const running = await createApp(loadConfig(), { background: false });
  try {
    await fn(running);
  } finally {
    await running.close();
  }
}

async function seed(running: RunningApp, v: Values): Promise<void> {
  const r = await seedDemo(running, {
    ...(v.products ? { products: z.coerce.number().int().min(1).max(100_000).parse(v.products) } : {}),
    ...(v['admin-email'] ? { adminEmail: z.email().parse(v['admin-email']) } : {}),
    ...(v['admin-password'] ? { adminPassword: Password.parse(v['admin-password']) } : {}),
  });
  console.log(
    r.catalogImported
      ? `Catalog: ${r.products} products, ${r.edges} graph edges, ${r.indexed} indexed.`
      : 'Catalog already seeded; skipped.',
  );
  if (r.admin) {
    console.log(`Admin: ${r.admin.email} / ${r.admin.password}`);
    console.log(
      `Admin TOTP secret (add it to an authenticator app now; it is not shown again): ${r.admin.totpSecret}`,
    );
    console.log(`  ${otpauth(r.admin.totpSecret)}`);
  } else {
    console.log('Admin: an account with that email already exists; unchanged.');
  }
  console.log(
    `Demo agent client: client_id=${r.agentClient.clientId} client_secret=${r.agentClient.clientSecret}`,
  );
}

async function createAdmin(running: RunningApp, v: Values): Promise<void> {
  const email = z.email().parse(v.email);
  const r = await running.app
    .get(AccountService)
    .createAdmin({ email, password: Password.parse(v.password), ...(v.name ? { name: v.name } : {}) });
  console.log(
    `Admin ${email} created (id ${r.userId}). MFA is on; this TOTP secret is shown once: ${r.totpSecret}`,
  );
  console.log(`  ${otpauth(r.totpSecret)}`);
}

async function createAgentClient(running: RunningApp, v: Values): Promise<void> {
  const input = CreateAgentClientInput.parse({
    name: v.name,
    scopes: (v.scopes ?? 'catalog:read quote:create order:create').split(/[\s,]+/).filter(Boolean),
    ...(v.quota ? { quotaPerMinute: Number(v.quota) } : {}),
  });
  const c = await running.app.get(AgentClientService).create(input, 'cli');
  console.log(`Agent client "${c.name}" scopes=${c.scopes.join(' ')} quota=${c.quotaPerMinute}/min`);
  console.log(`client_id=${c.clientId}`);
  console.log(`client_secret=${c.clientSecret} (shown once)`);
}

async function main(argv: string[]): Promise<void> {
  // `pii rewrap` is the one two-word command.
  const [command, ...rest] = argv[0] === 'pii' ? [`pii ${argv[1] ?? ''}`, ...argv.slice(2)] : argv;
  const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  switch (command) {
    case 'keys':
      for (const [k, v] of Object.entries(generateKeyEnv())) console.log(`${k}=${v}`);
      return;
    case 'migrate': {
      const database = await createDatabase(loadConfig());
      try {
        const applied = await migrate(database, loadMigrations(MIGRATIONS_DIR));
        console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date.');
      } finally {
        await database.close();
      }
      return;
    }
    case 'seed':
      return withApp((r) => seed(r, values));
    case 'reindex':
      return withApp(async (r) => {
        const n = await r.app.get(SearchIndexer).reindexAll(undefined, (done) => console.log(`... ${done} indexed`));
        console.log(`Indexed ${n} products.`);
      });
    case 'create-admin':
      return withApp((r) => createAdmin(r, values));
    case 'create-agent-client':
      return withApp((r) => createAgentClient(r, values));
    case 'pii rewrap': {
      const batch = z.coerce.number().int().min(1).max(10_000).parse(values['batch-size'] ?? 100);
      process.exitCode = await piiRewrap(loadConfig(), batch);
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== 'help') process.exitCode = 64; // EX_USAGE
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    if (err instanceof z.ZodError)
      console.error(`Invalid option: ${err.issues.map((i) => i.message).join('; ')}`);
    else console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
