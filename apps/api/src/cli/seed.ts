import { ALL_AGENT_SCOPES } from '@agentbazaar/contracts';
import { generateCatalog } from '@agentbazaar/testkit';
import type { RunningApp } from '../bootstrap/create-app.js';
import { CatalogService } from '../modules/catalog/index.js';
import { CustomizationService } from '../modules/customization/index.js';
import { AccountService, AgentClientService } from '../modules/identity/index.js';
import { RecommendationsService } from '../modules/recommendations/index.js';
import { SearchIndexer } from '../modules/search/index.js';
import { TaxService } from '../modules/tax/index.js';
import { randomToken } from '../shared/crypto/primitives.js';
import { inTransaction } from '../shared/db/database.js';
import { AppError } from '../shared/kernel/errors.js';

export interface SeedOptions {
  /** Catalog size including the hero products used by the demo and docs. Default 300. */
  products?: number;
  adminEmail?: string;
  /** Generated (and returned) when omitted. */
  adminPassword?: string;
}

export interface SeedResult {
  /** False when the catalog already had products; it is never imported twice. */
  catalogImported: boolean;
  products: number;
  edges: number;
  indexed: number;
  /** Null when an account with that email already exists. */
  admin: { email: string; password: string; totpSecret: string } | null;
  agentClient: { clientId: string; clientSecret: string };
}

/**
 * Demo data in one transaction (customization, catalog, GST rates, product graph), then the search
 * index, an admin with MFA enabled and a buyer-agent client with every scope. Used by `cli seed` and the demo app.
 */
export async function seedDemo(running: RunningApp, opts: SeedOptions = {}): Promise<SeedResult> {
  const get = running.app.get.bind(running.app);
  const catalog = get(CatalogService);
  const fresh = (await catalog.productIdsPage(null, 1)).length === 0;
  let products = 0;
  let edges = 0;
  if (fresh) {
    const seed = generateCatalog({ products: opts.products ?? 300 });
    await inTransaction(running.infra.db, async (tx) => {
      const schemaIds = await get(CustomizationService).importSeed(
        tx,
        seed.customizationSchemas,
        seed.designs,
      );
      const productIds = await catalog.importSeed(tx, seed, schemaIds);
      await get(TaxService).importRates(tx, seed.gstRates);
      edges = await get(RecommendationsService).importEdges(tx, seed.edges, productIds);
      products = productIds.size;
    });
  }
  const indexed = fresh ? await get(SearchIndexer).reindexAll() : 0;

  const email = opts.adminEmail ?? 'admin@example.com';
  const password = opts.adminPassword ?? `Ab1-${randomToken(12)}`;
  let admin: SeedResult['admin'] = null;
  try {
    const { totpSecret } = await get(AccountService).createAdmin({ email, password });
    admin = { email, password, totpSecret };
  } catch (e) {
    if (!(e instanceof AppError && e.code === 'conflict')) throw e;
  }
  const client = await get(AgentClientService).create(
    { name: 'Demo buyer agent', scopes: [...ALL_AGENT_SCOPES], quotaPerMinute: 600 },
    'cli',
  );
  return {
    catalogImported: fresh,
    products,
    edges,
    indexed,
    admin,
    agentClient: { clientId: client.clientId, clientSecret: client.clientSecret! },
  };
}
