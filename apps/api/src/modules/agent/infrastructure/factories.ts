import type { AppConfig } from '@agentbazaar/config';
import type { Logger } from 'pino';
import type { ClassifierPort, LlmPort } from '../domain/ports.js';
import { AiServiceClassifier, RulesClassifier } from './classifiers.js';
import { OpenAiCompatibleLlm } from './openai-compatible-llm.js';
import { RemoteGuard } from './resilient.js';
import { TemplateLlm } from './template-llm.js';

const LLM_TIMEOUT_MS = 10_000;
const CLASSIFIER_TIMEOUT_MS = 1_500;

/** Chosen by LLM_ADAPTER. loadConfig has already checked the selected adapter's settings. */
export async function createLlm(config: AppConfig, logger: Logger): Promise<LlmPort> {
  const env = config.env;
  const models = { small: env.LLM_SMALL_MODEL, large: env.LLM_LARGE_MODEL };
  const onError = (err: unknown) => logger.warn({ err }, 'LLM call failed; replying with the template');
  switch (config.adapters.llm) {
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
