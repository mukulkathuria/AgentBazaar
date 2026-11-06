import { z } from 'zod';

export const PROFILES = ['lite', 'growth', 'scale'] as const;
export type Profile = (typeof PROFILES)[number];

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
const optionalString = z.string().min(1).optional();

export const EnvSchema = z.object({
  PROFILE: z.enum(PROFILES, { error: `PROFILE must be one of: ${PROFILES.join(', ')}` }).default('lite'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  PUBLIC_WEB_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DEMO_MODE: bool.default(false),
  CORS_ORIGINS: csv.optional(),

  DATABASE_DRIVER: z.enum(['postgres', 'pglite']).default('postgres'),
  DATABASE_URL: optionalString,
  DATABASE_REPLICA_URLS: csv.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  PGLITE_DATA_DIR: optionalString,

  SEARCH_ADAPTER: z.enum(['postgres', 'meilisearch', 'opensearch']).optional(),
  MEILISEARCH_URL: z.url().optional(),
  MEILISEARCH_API_KEY: optionalString,
  OPENSEARCH_URL: z.url().optional(),
  QDRANT_URL: z.url().optional(),
  EVENT_BUS: z.enum(['inprocess', 'nats', 'kafka']).optional(),
  NATS_URL: optionalString,
  KAFKA_BROKERS: csv.optional(),
  CACHE_ADAPTER: z.enum(['memory', 'valkey']).optional(),
  VALKEY_URL: optionalString,
  SECRETS_ADAPTER: z.enum(['env', 'openbao']).optional(),
  OPENBAO_ADDR: z.url().optional(),
  OPENBAO_TOKEN: optionalString,
  OPENBAO_TRANSIT_KEY: z.string().default('agentbazaar-pii'),
  OPENBAO_TRANSIT_MOUNT: z.string().default('transit'),
  IDENTITY_PROVIDER: z.enum(['builtin', 'oidc']).default('builtin'),
  OIDC_ISSUER_URL: z.url().optional(),
  OIDC_AUDIENCE: z.string().default('agentbazaar-api'),

  JWT_PRIVATE_KEY: optionalString,
  QUOTE_SIGNING_KEY: optionalString,
  PII_MASTER_KEY: optionalString,
  PII_BLIND_INDEX_KEY: optionalString,

  LLM_ADAPTER: z.enum(['template', 'anthropic', 'openai-compatible']).default('template'),
  ANTHROPIC_API_KEY: optionalString,
  LLM_SMALL_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_LARGE_MODEL: z.string().default('claude-sonnet-5-5'),
  OPENAI_COMPAT_BASE_URL: z.url().optional(),
  OPENAI_COMPAT_API_KEY: optionalString,
  CLASSIFIER_ADAPTER: z.enum(['rules', 'ai-service']).default('rules'),
  EMBEDDINGS_ADAPTER: z.enum(['hash', 'ai-service']).default('hash'),
  AI_SERVICE_URL: z.url().optional(),
  /** Bearer token for services/ai when it runs with AI_SERVICE_TOKEN set. */
  AI_SERVICE_TOKEN: optionalString,
  ROUTER_SHADOW_MODE: bool.default(false),
  SESSION_TOKEN_BUDGET: z.coerce.number().int().min(500).max(1_000_000).default(20_000),
  /** Second model provider, used when the first fails or its circuit breaker is open. */
  LLM_FALLBACK_ADAPTER: z.enum(['none', 'anthropic', 'openai-compatible']).default('none'),
  LLM_FALLBACK_SMALL_MODEL: optionalString,
  LLM_FALLBACK_LARGE_MODEL: optionalString,
  /** Output-token cap per model call for router tier 2 (small model) and tier 3 (large model). */
  LLM_TIER2_MAX_TOKENS: z.coerce.number().int().min(32).max(4096).default(350),
  LLM_TIER3_MAX_TOKENS: z.coerce.number().int().min(32).max(4096).default(350),
  /** Reuse of guarded model wording for near-identical requests; numbers are always re-filled from policy. */
  SEMANTIC_CACHE: z.enum(['off', 'memory', 'valkey']).default('off'),
  SEMANTIC_CACHE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.9),
  LANGFUSE_HOST: z.url().optional(),
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,

  PAYMENT_ADAPTER: z.enum(['mock', 'razorpay', 'youpi-pg']).default('mock'),
  PAYMENT_ALLOW_SINGLE_SLOT: bool.default(false),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  YOUPI_BASE_URL: z.url().optional(),
  YOUPI_API_KEY: optionalString,
  YOUPI_WEBHOOK_SECRET: optionalString,
  MOCK_WEBHOOK_SECRET: optionalString,

  SELLER_NAME: z.string().default('AgentBazaar Demo Store'),
  SELLER_GSTIN: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { error: 'SELLER_GSTIN is not a valid GSTIN' })
    .optional(),
  SELLER_STATE_CODE: z.string().regex(/^[A-Z]{2}$/).default('DL'),
  GRIEVANCE_OFFICER_EMAIL: z.email().default('grievance@example.com'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
  MAILER: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: optionalString,
  ANALYTICS_INGEST_KEY: optionalString,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

type SearchAdapter = NonNullable<Env['SEARCH_ADAPTER']>;
type EventBus = NonNullable<Env['EVENT_BUS']>;
type CacheAdapter = NonNullable<Env['CACHE_ADAPTER']>;
type SecretsAdapter = NonNullable<Env['SECRETS_ADAPTER']>;

/** What each profile runs unless the operator overrides an adapter explicitly. */
export const PROFILE_DEFAULTS: Record<
  Profile,
  { search: SearchAdapter; eventBus: EventBus; cache: CacheAdapter; secrets: SecretsAdapter }
> = {
  lite: { search: 'postgres', eventBus: 'inprocess', cache: 'memory', secrets: 'env' },
  growth: { search: 'meilisearch', eventBus: 'nats', cache: 'valkey', secrets: 'openbao' },
  scale: { search: 'opensearch', eventBus: 'kafka', cache: 'valkey', secrets: 'openbao' },
};

/** Payment adapters that can serve only one payer at a time (capabilities.maxConcurrency === 1). */
export const SINGLE_SLOT_PAYMENT_ADAPTERS: readonly Env['PAYMENT_ADAPTER'][] = ['youpi-pg'];

export interface AppConfig {
  readonly profile: Profile;
  readonly env: Env;
  readonly isProduction: boolean;
  readonly adapters: {
    readonly search: SearchAdapter;
    readonly eventBus: EventBus;
    readonly cache: CacheAdapter;
    readonly secrets: SecretsAdapter;
    readonly identity: Env['IDENTITY_PROVIDER'];
    readonly llm: Env['LLM_ADAPTER'];
    readonly classifier: Env['CLASSIFIER_ADAPTER'];
    readonly embeddings: Env['EMBEDDINGS_ADAPTER'];
    readonly payment: Env['PAYMENT_ADAPTER'];
    readonly database: Env['DATABASE_DRIVER'];
  };
  readonly corsOrigins: readonly string[];
  readonly warnings: readonly string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function stripEmpty(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') out[k] = v.trim();
  return out;
}

function requireVars(env: Env, problems: string[], reason: string, keys: (keyof Env)[]): void {
  const missing = keys.filter((k) => env[k] === undefined);
  if (missing.length) problems.push(`${reason} requires ${missing.join(', ')}`);
}

function checkSecrets(env: Env, problems: string[], warnings: string[]): void {
  const secrets: (keyof Env)[] = ['QUOTE_SIGNING_KEY', 'PII_MASTER_KEY', 'PII_BLIND_INDEX_KEY'];
  if (env.IDENTITY_PROVIDER === 'builtin') secrets.push('JWT_PRIVATE_KEY');
  const missing = secrets.filter((k) => env[k] === undefined);
  if (!missing.length) return;
  if (env.NODE_ENV === 'production' && !env.DEMO_MODE) {
    problems.push(`NODE_ENV=production requires ${missing.join(', ')} (generate them with \`pnpm --filter @agentbazaar/api cli keys\`)`);
  } else {
    warnings.push(`Using ephemeral ${missing.join(', ')}: quotes, sessions and encrypted PII will not survive a restart.`);
  }
}

function checkPayments(env: Env, profile: Profile, problems: string[], warnings: string[]): void {
  const adapter = env.PAYMENT_ADAPTER;
  if (adapter === 'razorpay') {
    requireVars(env, problems, 'PAYMENT_ADAPTER=razorpay', ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']);
  }
  if (adapter === 'youpi-pg') {
    requireVars(env, problems, 'PAYMENT_ADAPTER=youpi-pg', ['YOUPI_BASE_URL', 'YOUPI_WEBHOOK_SECRET']);
    warnings.push('PAYMENT_ADAPTER=youpi-pg is EXPERIMENTAL: not bank-approved or audited. Fulfil UPI orders only after RECONCILED.');
  }
  if (SINGLE_SLOT_PAYMENT_ADAPTERS.includes(adapter)) {
    const msg = `PAYMENT_ADAPTER=${adapter} serves one payer at a time (maxConcurrency=1)`;
    if (profile === 'lite') warnings.push(msg);
    else if (!env.PAYMENT_ALLOW_SINGLE_SLOT) problems.push(`${msg}; PROFILE=${profile} needs PAYMENT_ALLOW_SINGLE_SLOT=true to start`);
  }
  if (adapter === 'mock' && env.NODE_ENV === 'production' && !env.DEMO_MODE) {
    warnings.push('PAYMENT_ADAPTER=mock in production: no real money will be collected.');
  }
  if (env.DEMO_MODE && adapter !== 'mock') problems.push('DEMO_MODE=true only works with PAYMENT_ADAPTER=mock');
}

function checkDatabase(env: Env, profile: Profile, problems: string[]): void {
  if (env.DATABASE_DRIVER === 'postgres') requireVars(env, problems, 'DATABASE_DRIVER=postgres', ['DATABASE_URL']);
  if (env.DATABASE_DRIVER !== 'pglite') return;
  if (env.NODE_ENV === 'production' && !env.DEMO_MODE) {
    problems.push('DATABASE_DRIVER=pglite is for demos and tests only; set DEMO_MODE=true or use postgres');
  }
  if (profile !== 'lite') problems.push(`PROFILE=${profile} needs a real Postgres (DATABASE_DRIVER=postgres)`);
}

/** Each selected adapter lists the variables it cannot start without. */
function checkServices(env: Env, profile: Profile, adapters: AppConfig['adapters'], problems: string[]): void {
  const p = `PROFILE=${profile}`;
  const needs: [boolean, string, (keyof Env)[]][] = [
    [adapters.search === 'meilisearch', `${p} with search adapter "meilisearch"`, ['MEILISEARCH_URL']],
    [adapters.search === 'opensearch', `${p} with search adapter "opensearch"`, ['OPENSEARCH_URL', 'QDRANT_URL']],
    [adapters.eventBus === 'nats', `${p} with event bus "nats"`, ['NATS_URL']],
    [adapters.eventBus === 'kafka', `${p} with event bus "kafka"`, ['KAFKA_BROKERS']],
    [adapters.cache === 'valkey', `${p} with cache "valkey"`, ['VALKEY_URL']],
    [adapters.secrets === 'openbao', `${p} with secrets "openbao"`, ['OPENBAO_ADDR', 'OPENBAO_TOKEN']],
    [adapters.identity === 'oidc', 'IDENTITY_PROVIDER=oidc', ['OIDC_ISSUER_URL']],
    [adapters.llm === 'anthropic', 'LLM_ADAPTER=anthropic', ['ANTHROPIC_API_KEY']],
    [adapters.llm === 'openai-compatible', 'LLM_ADAPTER=openai-compatible', ['OPENAI_COMPAT_BASE_URL']],
    [
      adapters.classifier === 'ai-service' || adapters.embeddings === 'ai-service',
      'The ai-service classifier/embeddings adapter',
      ['AI_SERVICE_URL'],
    ],
  ];
  for (const [selected, reason, keys] of needs) if (selected) requireVars(env, problems, reason, keys);
}

/** Model fallback, semantic cache and Langfuse settings that only work together. */
function checkAi(env: Env, adapters: AppConfig['adapters'], problems: string[]): void {
  const fallback = env.LLM_FALLBACK_ADAPTER;
  if (fallback !== 'none') {
    if (fallback === env.LLM_ADAPTER || env.LLM_ADAPTER === 'template') {
      problems.push(`LLM_FALLBACK_ADAPTER=${fallback} needs a different model adapter in LLM_ADAPTER`);
    }
    const credentials = fallback === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_COMPAT_BASE_URL';
    requireVars(env, problems, `LLM_FALLBACK_ADAPTER=${fallback}`, ['LLM_FALLBACK_SMALL_MODEL', 'LLM_FALLBACK_LARGE_MODEL', credentials]);
  }
  if (env.SEMANTIC_CACHE === 'valkey' && adapters.cache !== 'valkey') {
    problems.push('SEMANTIC_CACHE=valkey needs the valkey cache adapter (set VALKEY_URL)');
  }
  const langfuse: (keyof Env)[] = ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'];
  if (langfuse.some((k) => env[k] !== undefined)) requireVars(env, problems, 'Langfuse tracing', langfuse);
}

/** Parses and validates the environment. Throws ConfigError listing every problem at once. */
export function loadConfig(raw: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(stripEmpty(raw));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const env = parsed.data;
  const profile = env.PROFILE;
  const defaults = PROFILE_DEFAULTS[profile];
  const adapters = {
    search: env.SEARCH_ADAPTER ?? defaults.search,
    eventBus: env.EVENT_BUS ?? defaults.eventBus,
    cache: env.CACHE_ADAPTER ?? (env.VALKEY_URL ? 'valkey' : defaults.cache),
    secrets: env.SECRETS_ADAPTER ?? defaults.secrets,
    identity: env.IDENTITY_PROVIDER,
    llm: env.LLM_ADAPTER,
    classifier: env.CLASSIFIER_ADAPTER,
    embeddings: env.EMBEDDINGS_ADAPTER,
    payment: env.PAYMENT_ADAPTER,
    database: env.DATABASE_DRIVER,
  } as const;

  const problems: string[] = [];
  const warnings: string[] = [];
  checkDatabase(env, profile, problems);
  checkServices(env, profile, adapters, problems);
  checkAi(env, adapters, problems);
  checkPayments(env, profile, problems, warnings);
  if (env.DEMO_MODE) warnings.push('DEMO_MODE=true: anonymous agents get every scope. Never use with real payments.');
  checkSecrets(env, problems, warnings);

  if (problems.length) throw new ConfigError(problems);
  return {
    profile,
    env,
    isProduction: env.NODE_ENV === 'production',
    adapters,
    corsOrigins: env.CORS_ORIGINS ?? [env.PUBLIC_WEB_URL],
    warnings,
  };
}
