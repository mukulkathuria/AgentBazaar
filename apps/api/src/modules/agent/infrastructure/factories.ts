import type { AppConfig } from '@agentbazaar/config';
import type { Logger } from 'pino';
import { type Cache, MemoryCache } from '../../../shared/cache/cache.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import type { EmbeddingsPort } from '../../search/index.js';
import type { LlmTracer } from '../application/phraser.js';
import { SemanticCache } from '../application/semantic-cache.js';
import type { ClassifierPort, LlmPort } from '../domain/ports.js';
import type { ModelPair } from './anthropic-llm.js';
import { AiServiceClassifier, RulesClassifier } from './classifiers.js';
import { FallbackLlm } from './fallback-llm.js';
import { LangfuseTracer } from './langfuse-tracer.js';
import { OpenAiCompatibleLlm } from './openai-compatible-llm.js';
import { RemoteGuard } from './resilient.js';
import { TemplateLlm } from './template-llm.js';

const LLM_TIMEOUT_MS = 10_000;
const CLASSIFIER_TIMEOUT_MS = 1_500;
const SEMANTIC_CACHE_KEYS = 2_000;

type ModelAdapter = AppConfig['adapters']['llm'];

async function createAdapter(adapter: ModelAdapter, models: ModelPair, config: AppConfig, logger: Logger): Promise<LlmPort> {
  const env = config.env;
  const onError = (err: unknown) => logger.warn({ err, adapter }, 'LLM call failed; replying with the template');
  switch (adapter) {
    case 'anthropic': {
      // Loaded lazily: template-only deployments never import the SDK.
      const [{ default: Anthropic }, { AnthropicLlm }] = await Promise.all([import('@anthropic-ai/sdk'), import('./anthropic-llm.js')]);
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: LLM_TIMEOUT_MS });
      return new AnthropicLlm(client.messages, models, env.SELLER_NAME, new RemoteGuard('anthropic', { timeoutMs: LLM_TIMEOUT_MS }), onError);
    }
    case 'openai-compatible':
      return new OpenAiCompatibleLlm(
        { baseUrl: env.OPENAI_COMPAT_BASE_URL!, apiKey: env.OPENAI_COMPAT_API_KEY, models, seller: env.SELLER_NAME },
        new RemoteGuard('openai-compatible', { timeoutMs: LLM_TIMEOUT_MS }),
        fetch,
        onError,
      );
    default:
      return new TemplateLlm();
  }
}

/**
 * Model routing, chosen by LLM_ADAPTER and LLM_FALLBACK_ADAPTER: tier 2 runs the provider's small
 * model, tier 3 its large one, and a second provider answers while the first is failing or its circuit
 * breaker is open. loadConfig has already checked each selected adapter's settings.
 */
export async function createLlm(config: AppConfig, logger: Logger): Promise<LlmPort> {
  const env = config.env;
  const primary = await createAdapter(config.adapters.llm, { small: env.LLM_SMALL_MODEL, large: env.LLM_LARGE_MODEL }, config, logger);
  if (env.LLM_FALLBACK_ADAPTER === 'none') return primary;
  const fallbackModels = { small: env.LLM_FALLBACK_SMALL_MODEL!, large: env.LLM_FALLBACK_LARGE_MODEL! };
  return new FallbackLlm([primary, await createAdapter(env.LLM_FALLBACK_ADAPTER, fallbackModels, config, logger)]);
}

/** Chosen by CLASSIFIER_ADAPTER: in-process rules, or the AI service with rules as the fallback. */
export function createClassifier(config: AppConfig, logger: Logger): ClassifierPort {
  const rules = new RulesClassifier();
  if (config.adapters.classifier !== 'ai-service') return rules;
  const token = config.env.AI_SERVICE_TOKEN;
  return new AiServiceClassifier(
    config.env.AI_SERVICE_URL!,
    new RemoteGuard('ai-service', { timeoutMs: CLASSIFIER_TIMEOUT_MS }),
    rules,
    fetch,
    (err) => logger.warn({ err }, 'AI service classify failed; using the rules classifier'),
    token ? { authorization: `Bearer ${token}` } : {},
  );
}

/** Langfuse when LANGFUSE_HOST and its keys are set (loadConfig checks they come together); otherwise nothing. */
export function createTracer(config: AppConfig, logger: Logger): LlmTracer {
  const env = config.env;
  if (!env.LANGFUSE_HOST) return { record: () => undefined };
  return new LangfuseTracer({
    host: env.LANGFUSE_HOST,
    publicKey: env.LANGFUSE_PUBLIC_KEY!,
    secretKey: env.LANGFUSE_SECRET_KEY!,
    onError: (err) => logger.warn({ err }, 'Langfuse export failed; spans dropped'),
  });
}

/** SEMANTIC_CACHE: off, a bounded in-process store, or the shared Valkey cache (loadConfig checks it is Valkey). */
export function createSemanticCache(config: AppConfig, cache: Cache, embeddings: EmbeddingsPort, metrics: Metrics, logger: Logger): SemanticCache {
  const mode = config.env.SEMANTIC_CACHE;
  const store = mode === 'valkey' ? cache : mode === 'memory' ? new MemoryCache(SEMANTIC_CACHE_KEYS) : null;
  return new SemanticCache(store, embeddings, config.env.SEMANTIC_CACHE_THRESHOLD, metrics, 'semcache:', (err) =>
    logger.warn({ err }, 'Semantic cache unavailable; calling the model'),
  );
}
