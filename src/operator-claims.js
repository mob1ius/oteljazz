/**
 * Crawler UA taxonomy: what a request CLAIMS to be, parsed from its User-Agent.
 *
 * Deliberately its own file, separate from the Worker that uses it. This list needs updates on
 * its own schedule, independent of any single site's release cycle -- a vendor ships a new UA
 * token, this file gets a line added, every deploy using it benefits without a redeploy of the
 * logging logic itself. Letting it drift inside a site-specific Worker is exactly what produced
 * the v1.2.1 bug: ClaudeBot was recognized, Claude-SearchBot (a separate, real, documented
 * Anthropic UA for search-index fetches, not training) was not, and 155 real requests sat
 * misclassified as unlabeled for over a week before anyone looked closely enough to notice.
 *
 * A user-agent is a CLAIM, not evidence: anyone can send `GPTBot/1.2` from a home connection in
 * one curl. This file only records the claim. Pair it against the request's actual ASN (which the
 * sender does not control) to arbitrate; see infra/verify_crawlers.sql for that half.
 *
 * Deliberately no hardcoded ASN allowlist anywhere in this taxonomy: published crawler IP ranges
 * change, and baking a possibly-stale list into the collector would silently mislabel rows at the
 * moment of collection, where it can never be corrected. Classification against ASN ranges
 * belongs at analysis time, against ranges fetched then.
 */

export const OPERATOR_CLAIMS = [
  ['gptbot', /GPTBot/i],
  ['oai-searchbot', /OAI-SearchBot/i],
  ['chatgpt-user', /ChatGPT-User/i],
  ['claudebot', /ClaudeBot|anthropic-ai|Claude-Web/i],
  // Distinct from ClaudeBot above -- Anthropic's own documented UA taxonomy, three separate
  // tokens for three separate purposes (training crawl vs. search-index fetch vs. user-triggered
  // fetch). The ClaudeBot pattern doesn't match either: the hyphen breaks it.
  ['claude-searchbot', /Claude-SearchBot/i],
  ['claude-user', /Claude-User/i],
  ['perplexitybot', /PerplexityBot/i],
  ['perplexity-user', /Perplexity-User/i],
  ['ccbot', /CCBot/i],
  ['google-extended', /Google-Extended/i],
  ['googlebot', /Googlebot/i],
  ['bingbot', /bingbot/i],
  ['applebot', /Applebot/i],
  ['bytespider', /Bytespider/i],
  ['amazonbot', /Amazonbot/i],
  ['meta-externalagent', /meta-externalagent|FacebookBot/i],
  ['duckduckbot', /DuckDuckBot/i],
];

export function claimedOperator(ua) {
  if (!ua) return null;
  for (const [name, re] of OPERATOR_CLAIMS) if (re.test(ua)) return name;
  return null;                              // self-identifies as nobody in particular
}
