import { describe, expect, it } from 'vitest';
import { classifyVisit, detectAiCrawler, detectAiReferrer } from './detect';

describe('AI crawler detection', () => {
  it.each([
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', 'GPTBot'],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0)', 'PerplexityBot'],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot'],
    ['Mozilla/5.0 ... ChatGPT-User/1.0; +https://openai.com/bot', 'ChatGPT-User'],
    ['mozilla/5.0 (compatible; oai-searchbot/1.0)', 'OAI-SearchBot'],
  ])('detects %s', (ua, bot) => {
    expect(detectAiCrawler(ua)).toBe(bot);
  });

  it('ignores browsers and classic search crawlers', () => {
    expect(detectAiCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36')).toBeNull();
    expect(detectAiCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBeNull();
    expect(detectAiCrawler(null)).toBeNull();
  });
});

describe('AI referrer detection', () => {
  it.each([
    ['https://chatgpt.com/', 'chatgpt.com'],
    ['https://chat.openai.com/c/123', 'chat.openai.com'],
    ['https://www.perplexity.ai/search?q=gpu', 'perplexity.ai'],
    ['https://claude.ai/chat/abc', 'claude.ai'],
    ['https://gemini.google.com/app', 'gemini.google.com'],
    ['https://copilot.microsoft.com/', 'copilot.microsoft.com'],
  ])('detects %s', (referer, site) => {
    expect(detectAiReferrer(referer)).toBe(site);
  });

  it('does not match look-alike or unrelated hosts', () => {
    expect(detectAiReferrer('https://evilchatgpt.com/')).toBeNull();
    expect(detectAiReferrer('https://claude.ai.evil.example/')).toBeNull();
    expect(detectAiReferrer('https://www.google.com/')).toBeNull();
    expect(detectAiReferrer('not a url')).toBeNull();
  });

  it('classifies a visit, preferring the crawler signal', () => {
    expect(classifyVisit('GPTBot/1.2', 'https://chatgpt.com/')).toEqual({ kind: 'crawler_hit', agent: 'GPTBot' });
    expect(classifyVisit('Mozilla/5.0 Safari', 'https://claude.ai/')).toEqual({ kind: 'ai_referral', agent: 'claude.ai' });
    expect(classifyVisit('Mozilla/5.0 Safari', 'https://agentbazaar.example/p/x')).toBeNull();
  });
});
