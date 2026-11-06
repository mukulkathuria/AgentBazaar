import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './index.js';

const base = { DATABASE_URL: 'postgres://localhost/db' };

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe('@lite config profile loader', () => {
  it('defaults to lite with Postgres search and the in-process bus', () => {
    const cfg = loadConfig(base);
    expect(cfg.profile).toBe('lite');
    expect(cfg.adapters).toMatchObject({ search: 'postgres', eventBus: 'inprocess', cache: 'memory', payment: 'mock' });
  });

  it('keeps analytics in Postgres unless ClickHouse is chosen, which then needs CLICKHOUSE_URL', () => {
    expect(loadConfig({ ...base, PROFILE: 'lite' }).adapters.analytics).toBe('postgres');
    expect(problemsOf({ ...base, ANALYTICS_ADAPTER: 'clickhouse' })).toEqual(['ANALYTICS_ADAPTER=clickhouse requires CLICKHOUSE_URL']);
    const url = 'http://agentbazaar:x@clickhouse:8123/agentbazaar';
    expect(loadConfig({ ...base, ANALYTICS_ADAPTER: 'clickhouse', CLICKHOUSE_URL: url }).adapters.analytics).toBe('clickhouse');
    expect(problemsOf({ ...base, ANALYTICS_ADAPTER: 'druid' })).toEqual([expect.stringContaining('ANALYTICS_ADAPTER')]);
  });

  it('switches cache to valkey when VALKEY_URL is present in lite', () => {
    expect(loadConfig({ ...base, VALKEY_URL: 'redis://localhost:6379' }).adapters.cache).toBe('valkey');
  });

  it('fails fast with a clear message for an unknown profile', () => {
    expect(problemsOf({ ...base, PROFILE: 'mega' })).toEqual(['PROFILE: PROFILE must be one of: lite, growth, scale']);
  });

  it('lists every missing growth service at once', () => {
    const problems = problemsOf({ ...base, PROFILE: 'growth' });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('MEILISEARCH_URL'),
        expect.stringContaining('NATS_URL'),
        expect.stringContaining('VALKEY_URL'),
        expect.stringContaining('OPENBAO_ADDR, OPENBAO_TOKEN'),
      ]),
    );
  });

  it('accepts a complete scale profile', () => {
    const cfg = loadConfig({
      ...base,
      PROFILE: 'scale',
      OPENSEARCH_URL: 'http://os:9200',
      QDRANT_URL: 'http://qdrant:6333',
      KAFKA_BROKERS: 'k1:9092, k2:9092',
      VALKEY_URL: 'redis://valkey:6379',
      OPENBAO_ADDR: 'http://bao:8200',
      OPENBAO_TOKEN: 't',
    });
    expect(cfg.adapters).toMatchObject({ search: 'opensearch', eventBus: 'kafka', secrets: 'openbao' });
    expect(cfg.env.KAFKA_BROKERS).toEqual(['k1:9092', 'k2:9092']);
  });

  it('runs checkout in-process by default; the Temporal engine needs its address', () => {
    expect(loadConfig(base).env).toMatchObject({
      WORKFLOW_ENGINE: 'inprocess',
      TEMPORAL_NAMESPACE: 'default',
      TEMPORAL_TASK_QUEUE: 'agentbazaar-checkout',
    });
    expect(problemsOf({ ...base, WORKFLOW_ENGINE: 'temporal' })).toEqual([
      'WORKFLOW_ENGINE=temporal requires TEMPORAL_ADDRESS',
    ]);
    expect(problemsOf({ ...base, WORKFLOW_ENGINE: 'airflow' })).toEqual([
      expect.stringContaining('WORKFLOW_ENGINE'),
    ]);
    expect(loadConfig({ ...base, WORKFLOW_ENGINE: 'temporal', TEMPORAL_ADDRESS: 'temporal:7233' }).env.TEMPORAL_ADDRESS).toBe(
      'temporal:7233',
    );
  });

  it('requires a database URL for postgres and refuses pglite outside lite', () => {
    expect(problemsOf({})).toEqual([expect.stringContaining('DATABASE_URL')]);
    expect(problemsOf({ DATABASE_DRIVER: 'pglite', PROFILE: 'growth' })).toEqual(
      expect.arrayContaining([expect.stringContaining('needs a real Postgres')]),
    );
  });

  it('reads replica URLs and a lag limit, and refuses replicas without postgres', () => {
    const cfg = loadConfig({ ...base, DATABASE_REPLICA_URLS: 'postgres://r1/db, postgres://r2/db' });
    expect(cfg.env.DATABASE_REPLICA_URLS).toEqual(['postgres://r1/db', 'postgres://r2/db']);
    expect(cfg.env.DATABASE_REPLICA_MAX_LAG_MS).toBe(5_000);
    expect(problemsOf({ ...base, DATABASE_REPLICA_MAX_LAG_MS: '10' })[0]).toContain('DATABASE_REPLICA_MAX_LAG_MS');
    expect(problemsOf({ DATABASE_DRIVER: 'pglite', DATABASE_REPLICA_URLS: 'postgres://r1/db' })).toEqual([
      'DATABASE_REPLICA_URLS needs DATABASE_DRIVER=postgres',
    ]);
  });

  it('requires real secrets in production but only warns in development', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production' })[0]).toContain('QUOTE_SIGNING_KEY');
    expect(loadConfig(base).warnings.join(' ')).toContain('ephemeral');
  });

  it('refuses pglite in production unless it is a demo', () => {
    expect(problemsOf({ DATABASE_DRIVER: 'pglite', NODE_ENV: 'production' })).toEqual(
      expect.arrayContaining([expect.stringContaining('demos and tests only')]),
    );
    expect(loadConfig({ DATABASE_DRIVER: 'pglite', NODE_ENV: 'production', DEMO_MODE: 'true' }).env.DEMO_MODE).toBe(true);
  });

  it('warns for single-slot YouPI-PG in lite and blocks it in growth unless overridden', () => {
    const youpi = { PAYMENT_ADAPTER: 'youpi-pg', YOUPI_BASE_URL: 'http://youpi:3000', YOUPI_WEBHOOK_SECRET: 's' };
    expect(loadConfig({ ...base, ...youpi }).warnings.join(' ')).toContain('maxConcurrency=1');
    const growth = {
      ...base,
      ...youpi,
      PROFILE: 'growth',
      MEILISEARCH_URL: 'http://m:7700',
      NATS_URL: 'nats://n:4222',
      VALKEY_URL: 'redis://v:6379',
      OPENBAO_ADDR: 'http://b:8200',
      OPENBAO_TOKEN: 't',
    };
    expect(problemsOf(growth)).toEqual([expect.stringContaining('PAYMENT_ALLOW_SINGLE_SLOT')]);
    expect(loadConfig({ ...growth, PAYMENT_ALLOW_SINGLE_SLOT: 'true' }).adapters.payment).toBe('youpi-pg');
  });

  it('requires gateway credentials for razorpay and keys for LLM adapters', () => {
    expect(problemsOf({ ...base, PAYMENT_ADAPTER: 'razorpay' })[0]).toContain('RAZORPAY_KEY_ID');
    expect(problemsOf({ ...base, LLM_ADAPTER: 'anthropic' })[0]).toContain('ANTHROPIC_API_KEY');
  });

  it('keeps the AI efficiency features off by default and checks their settings', () => {
    expect(loadConfig(base).env).toMatchObject({ SEMANTIC_CACHE: 'off', LLM_FALLBACK_ADAPTER: 'none', LLM_TIER3_MAX_TOKENS: 350 });
    const anthropic = { ...base, LLM_ADAPTER: 'anthropic', ANTHROPIC_API_KEY: 'test-key' };
    expect(problemsOf({ ...anthropic, LLM_FALLBACK_ADAPTER: 'openai-compatible' })).toEqual([
      expect.stringContaining('LLM_FALLBACK_SMALL_MODEL, LLM_FALLBACK_LARGE_MODEL, OPENAI_COMPAT_BASE_URL'),
    ]);
    expect(problemsOf({ ...anthropic, LLM_FALLBACK_ADAPTER: 'anthropic', LLM_FALLBACK_SMALL_MODEL: 'a', LLM_FALLBACK_LARGE_MODEL: 'b' })).toEqual([
      expect.stringContaining('needs a different model adapter'),
    ]);
    expect(problemsOf({ ...base, SEMANTIC_CACHE: 'valkey' })).toEqual([expect.stringContaining('SEMANTIC_CACHE=valkey')]);
    expect(loadConfig({ ...base, SEMANTIC_CACHE: 'valkey', VALKEY_URL: 'redis://v:6379' }).env.SEMANTIC_CACHE).toBe('valkey');
    expect(problemsOf({ ...base, SEMANTIC_CACHE_THRESHOLD: '0.2' })[0]).toContain('SEMANTIC_CACHE_THRESHOLD');
    expect(problemsOf({ ...base, LANGFUSE_HOST: 'http://langfuse:3000' })).toEqual([expect.stringContaining('LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY')]);
  });

  it('demo mode only runs with the mock payment adapter', () => {
    const env = {
      ...base,
      DEMO_MODE: 'true',
      PAYMENT_ADAPTER: 'razorpay',
      RAZORPAY_KEY_ID: 'a',
      RAZORPAY_KEY_SECRET: 'b',
      RAZORPAY_WEBHOOK_SECRET: 'c',
    };
    expect(problemsOf(env)).toEqual(
      expect.arrayContaining([expect.stringContaining('DEMO_MODE=true only works with PAYMENT_ADAPTER=mock')]),
    );
  });

  it('treats blank variables as unset and validates GSTIN', () => {
    expect(loadConfig({ ...base, MEILISEARCH_URL: '  ' }).env.MEILISEARCH_URL).toBeUndefined();
    expect(problemsOf({ ...base, SELLER_GSTIN: 'NOT-A-GSTIN' })[0]).toContain('GSTIN');
    expect(loadConfig({ ...base, SELLER_GSTIN: '07AAACA1234A1Z5' }).env.SELLER_GSTIN).toBe('07AAACA1234A1Z5');
  });
});
