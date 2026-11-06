/** robots.txt / user-agent tokens of AI crawlers and AI assistants' fetchers. */
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'Amazonbot',
  'Meta-ExternalAgent',
  'cohere-ai',
  'DuckAssistBot',
  'MistralAI-User',
] as const;

export const AI_REFERRERS = [
  'chatgpt.com',
  'chat.openai.com',
  'perplexity.ai',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
] as const;

export function detectAiCrawler(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  return AI_CRAWLERS.find((bot) => ua.includes(bot.toLowerCase())) ?? null;
}

export function detectAiReferrer(referer: string | null): string | null {
  if (!referer) return null;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return null;
  }
  return AI_REFERRERS.find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
}

export interface Visit {
  kind: 'crawler_hit' | 'ai_referral';
  agent: string;
}

export function classifyVisit(userAgent: string | null, referer: string | null): Visit | null {
  const bot = detectAiCrawler(userAgent);
  if (bot) return { kind: 'crawler_hit', agent: bot };
  const site = detectAiReferrer(referer);
  return site ? { kind: 'ai_referral', agent: site } : null;
}
