// The Anthropic API's prices: the one table every cost in the engine is computed
// from (ledger.js), and the one place to change when the pricing page changes.
//
// $ per 1M tokens: input, output, cache read, 5-minute and 1-hour cache writes.
// Claude Haiku 5.5 has a second tier for prompts over 100,000 tokens.
// A model that is not here is recorded at the dearest rate in the table
// (ledger.js WORST): a cost overstated, never hidden.

/** The day these were last read from platform.claude.com/docs/en/about-claude/pricing. */
export const PRICES_VERIFIED = '2026-10-13';

export const MODEL_RATES = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, write5m: 12.5, write1h: 20 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, write5m: 5, write1h: 8 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1, write5m: 2.5, write1h: 4 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, write5m: 2.5, write1h: 4 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2, long: { over: 100_000, in: 0.5, out: 2.5, cacheRead: 0.05, write5m: 0.625, write1h: 1 } },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 },
};

/** The Message Batches API: half price on every token, cache reads and writes included. */
export const BATCH_FACTOR = 0.5;
