/**
 * Anthropic API list prices (USD per million tokens), from
 * https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-16).
 *
 * The hub meters every request with these prices so it knows how much of each
 * account's monthly credit is left. Unknown models are priced like the most
 * expensive family so the hub errs toward stopping early, never late.
 */

export interface ModelPrice {
  family: string;
  input: number;
  write5m: number;
  write1h: number;
  cacheRead: number;
  output: number;
  /** Fast mode (`speed: "fast"`) input/output prices, when the model offers it. */
  fastInput?: number;
  fastOutput?: number;
  /** Haiku 5.5 charges more when the whole prompt is over 100k tokens. */
  longPromptThreshold?: number;
  long?: Omit<ModelPrice, 'family' | 'long' | 'longPromptThreshold'>;
}

const FABLE_51: ModelPrice = { family: 'fable-5.1', input: 10, write5m: 12.5, write1h: 20, cacheRead: 0.25, output: 50 };
const FABLE_5: ModelPrice = { family: 'fable-5', input: 10, write5m: 12.5, write1h: 20, cacheRead: 1, output: 50 };
const OPUS_55: ModelPrice = { family: 'opus-5.5', input: 4, write5m: 5, write1h: 8, cacheRead: 0.2, output: 20, fastInput: 8, fastOutput: 40 };
const OPUS_5: ModelPrice = { family: 'opus-5', input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25, fastInput: 10, fastOutput: 50 };
const OPUS_48: ModelPrice = { ...OPUS_5, family: 'opus-4.8' };
const OPUS_45_47: ModelPrice = { family: 'opus-4.5-4.7', input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 };
const OPUS_4_41: ModelPrice = { family: 'opus-4-4.1', input: 15, write5m: 18.75, write1h: 30, cacheRead: 1.5, output: 75 };
const SONNET_55: ModelPrice = { family: 'sonnet-5.5', input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.1, output: 10 };
const SONNET_5: ModelPrice = { family: 'sonnet-5', input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.2, output: 10 };
const SONNET_4X: ModelPrice = { family: 'sonnet-4.x', input: 3, write5m: 3.75, write1h: 6, cacheRead: 0.3, output: 15 };
const HAIKU_55: ModelPrice = {
  family: 'haiku-5.5', input: 0.1, write5m: 0.125, write1h: 0.2, cacheRead: 0.01, output: 0.5,
  longPromptThreshold: 100_000,
  long: { input: 0.5, write5m: 0.625, write1h: 1, cacheRead: 0.05, output: 2.5 },
};
const HAIKU_45: ModelPrice = { family: 'haiku-4.5', input: 1, write5m: 1.25, write1h: 2, cacheRead: 0.1, output: 5 };
const HAIKU_35: ModelPrice = { family: 'haiku-3.5', input: 0.8, write5m: 1, write1h: 1.6, cacheRead: 0.08, output: 4 };

/** The fallback for model ids this table does not know: the highest listed prices. */
export const UNKNOWN_MODEL: ModelPrice = { ...FABLE_5, family: 'unknown' };

const RULES: Array<[RegExp, ModelPrice]> = [
  [/(fable|mythos)-5-1/, FABLE_51],
  [/(fable|mythos)-5/, FABLE_5],
  [/opus-5-5/, OPUS_55],
  [/opus-5(?!-[1-9](\D|$))/, OPUS_5],
  [/opus-4-8/, OPUS_48],
  [/opus-4-[567]/, OPUS_45_47],
  [/opus-4(-1|-0|-2025|$)/, OPUS_4_41],
  [/sonnet-5-5/, SONNET_55],
  [/sonnet-5(?!-[1-9](\D|$))/, SONNET_5],
  [/sonnet-4/, SONNET_4X],
  [/haiku-5-5/, HAIKU_55],
  [/haiku-4-5/, HAIKU_45],
  [/3-5-haiku|haiku-3-5/, HAIKU_35],
];

export function priceFor(model: string | undefined): ModelPrice {
  const id = (model ?? '').toLowerCase().replace(/\./g, '-');
  for (const [re, price] of RULES) if (re.test(id)) return price;
  return UNKNOWN_MODEL;
}

/** Web search is billed at $10 per 1,000 searches on top of tokens. */
export const WEB_SEARCH_USD = 0.01;

export interface UsageCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** One billed sub-inference: executor turns, advisor calls, server-side fallback attempts. */
export interface Iteration extends UsageCounts {
  type?: string;
  model?: string;
  speed?: string;
}

export interface Usage extends UsageCounts {
  server_tool_use?: { web_search_requests?: number };
  speed?: string;
  inference_geo?: string;
  iterations?: Iteration[];
}

export interface CostContext {
  /** The model the request asked for (executor). */
  model?: string;
  /** The model the reply says served it; differs after a server-side fallback. */
  servedModel?: string;
  /** From the request body: `speed: "fast"`. */
  fast?: boolean;
  /** From the request body: `inference_geo: "us"` adds 10%. */
  usOnly?: boolean;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Token cost (before the US-only multiplier) of one block of counts at one model's prices. */
function countsCost(c: UsageCounts, model: string | undefined, fast: boolean): number {
  const base = priceFor(model);
  const input = n(c.input_tokens);
  const output = n(c.output_tokens);
  const read = n(c.cache_read_input_tokens);
  const w5 = n(c.cache_creation?.ephemeral_5m_input_tokens);
  let w1 = n(c.cache_creation?.ephemeral_1h_input_tokens);
  const writeTotal = n(c.cache_creation_input_tokens);
  // When only the total is reported, price the unexplained part at the 1h rate (the dearer one).
  if (writeTotal > w5 + w1) w1 += writeTotal - w5 - w1;

  let p: Omit<ModelPrice, 'family' | 'long' | 'longPromptThreshold'> = base;
  if (base.longPromptThreshold && base.long && input + read + w5 + w1 > base.longPromptThreshold) p = base.long;
  const inFactor = fast && base.fastInput ? base.fastInput / base.input : 1;
  const outFactor = fast && base.fastOutput ? base.fastOutput / base.output : 1;
  return ((input * p.input + w5 * p.write5m + w1 * p.write1h + read * p.cacheRead) * inFactor + output * p.output * outFactor) / 1_000_000;
}

/**
 * Cost in USD of one finished request, from the usage block the API returned.
 * When `usage.iterations` is present it is the billing record: each entry is
 * priced at the model that ran it, and the top-level counts are not added again.
 */
export function costOf(usage: Usage, ctx: CostContext): number {
  const fast = !!ctx.fast || usage.speed === 'fast';
  const geo = ctx.usOnly || usage.inference_geo === 'us' ? 1.1 : 1;
  const served = ctx.servedModel || ctx.model;
  let tokens: number;
  if (Array.isArray(usage.iterations) && usage.iterations.length > 0) {
    tokens = 0;
    for (const it of usage.iterations) {
      const model = it.model || (it.type === 'fallback_message' ? served : ctx.model) || served;
      // Each attempt's own speed when reported; otherwise the request's (never fast for the advisor).
      const itFast = it.speed !== undefined ? it.speed === 'fast' : fast && it.type !== 'advisor_message';
      tokens += countsCost(it, model, itFast);
    }
  } else {
    tokens = countsCost(usage, served, fast);
  }
  return tokens * geo + n(usage.server_tool_use?.web_search_requests) * WEB_SEARCH_USD;
}
