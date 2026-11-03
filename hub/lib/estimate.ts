/**
 * A deliberately high guess of what one request can cost, made before it is sent.
 *
 * The hub sets this amount aside on the chosen account while the request runs,
 * so several requests arriving at once can never add up to more than the
 * account's remaining credit. The real cost replaces it when the reply ends.
 */

import { priceFor, WEB_SEARCH_USD } from './pricing';

export interface RequestShape {
  model?: string;
  maxTokens: number;
  fast: boolean;
  usOnly: boolean;
  stream: boolean;
  /** Prompt tokens, guessed high from the request text. */
  inputTokens: number;
  /**
   * A hard upper bound on prompt tokens, used under HUB_PAID_MONTHLY_CAP_USD: every UTF-8 byte of the whole
   * serialized request (keys included, base64 payloads left out) counts as one token — a token never covers less
   * than one byte — plus a generous fixed bound per image and the fixed overheads.
   */
  strictInputTokens: number;
  webSearches: number;
  /** Extra billed sub-inferences the request allows: advisor calls and server-side fallbacks. */
  extraRuns: Array<{ model?: string; maxTokens: number; fast: boolean; count: number }>;
}

const IMAGE_TOKENS = 2_000;
/** Under a paid cap an image is bounded well above the largest image Anthropic bills today. */
const STRICT_IMAGE_TOKENS = 10_000;
/** A PDF fetched by URL: its size is unknown before sending. */
const URL_DOCUMENT_TOKENS = 60_000;
/** Request scaffolding and each tool definition's system-prompt overhead. */
const BASE_OVERHEAD_TOKENS = 1_000;
const PER_TOOL_TOKENS = 800;
/** Search results come back as input to later turns of the same request. */
const PER_SEARCH_TOKENS = 8_000;
/**
 * The advisor tool allows unlimited calls by default and up to the advisor model's
 * output cap per call; the hub assumes 10 calls of 32k tokens unless the request sets
 * its own limits. Anthropic's own empty-balance stop is the final guard beyond that.
 */
const DEFAULT_ADVISOR_USES = 10;
const DEFAULT_ADVISOR_MAX_TOKENS = 32_000;

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * A high token guess for text: Korean and other non-ASCII text can run above one
 * token per character on the newer tokenizer, English about four characters per token.
 */
export function textTokens(s: string): number {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return ascii / 3 + (s.length - ascii) * 1.3;
}

/**
 * The base64 `source` objects of image and document content blocks, found only where Anthropic reads them as
 * attachments: directly in messages[].content[], or in a tool_result block's content[]. Anything else shaped like
 * `{type: "base64", data}` (for example inside tool_use.input) is ordinary billable JSON and is counted verbatim.
 */
function mediaSources(body: Record<string, unknown>): Map<object, 'image' | 'document'> {
  const found = new Map<object, 'image' | 'document'>();
  const visit = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      const src = block.source as Record<string, unknown> | undefined;
      if ((block.type === 'image' || block.type === 'document') && src && typeof src === 'object' && src.type === 'base64' && typeof src.data === 'string') {
        found.set(src, block.type);
      }
      if (block.type === 'tool_result') visit(block.content);
    }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) if (m && typeof m === 'object') visit((m as Record<string, unknown>).content);
  return found;
}

/** Walks the request body; attachments are counted by kind, not by base64 length. */
export function shapeOf(body: Record<string, unknown>): RequestShape {
  let textTok = 0;
  let images = 0;
  let docBytes = 0;
  let urlDocs = 0;
  const media = mediaSources(body);

  const walk = (v: unknown, key?: string, parent?: Record<string, unknown>) => {
    if (typeof v === 'string') {
      const kind = key === 'data' && parent ? media.get(parent) : undefined;
      if (kind === 'image') { images += 1; return; }
      if (kind === 'document') { docBytes += (v.length * 3) / 4; return; }
      textTok += textTokens(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const src = o.source as Record<string, unknown> | undefined;
      if (src && (src.type === 'url' || src.type === 'file')) {
        if (o.type === 'image') images += 1;
        else urlDocs += 1;
      }
      // Property names are billable text too (e.g. a tool's input_schema).
      for (const [k, x] of Object.entries(o)) { textTok += textTokens(k); walk(x, k, o); }
    }
  };
  walk(body.system);
  walk(body.messages);
  walk(body.tools);

  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
  const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 4096;
  let webSearches = 0;
  const extraRuns: RequestShape['extraRuns'] = [];
  const fast = body.speed === 'fast';
  for (const t of tools) {
    const type = typeof t?.type === 'string' ? t.type : '';
    if (type.startsWith('web_search')) webSearches += positiveInt(t.max_uses, 10);
    if (type.startsWith('advisor')) {
      extraRuns.push({
        model: typeof t.model === 'string' ? t.model : undefined,
        maxTokens: positiveInt(t.max_tokens, DEFAULT_ADVISOR_MAX_TOKENS),
        fast: false,
        count: positiveInt(t.max_uses, DEFAULT_ADVISOR_USES),
      });
    }
  }
  // Server-side fallbacks: a list of up to three models (each may override max_tokens/speed),
  // or Anthropic's default routing, whose model is unknown and so priced at the top rate.
  if (Array.isArray(body.fallbacks)) {
    for (const f of (body.fallbacks as unknown[]).slice(0, 3)) {
      const o = (typeof f === 'string' ? { model: f } : f ?? {}) as Record<string, unknown>;
      extraRuns.push({
        model: typeof o.model === 'string' && o.model !== 'default' ? o.model : undefined,
        maxTokens: positiveInt(o.max_tokens, maxTokens),
        fast: o.speed === undefined ? fast : o.speed === 'fast',
        count: 1,
      });
    }
  } else if (body.fallbacks !== undefined && body.fallbacks !== null) {
    extraRuns.push({ model: undefined, maxTokens, fast, count: 1 });
  }

  // Strict bound: the serialized request, one token per byte, leaving out only the base64 bytes of images at
  // attachment locations (each image is bounded per item instead). Everything else counts verbatim.
  const serialized = JSON.stringify(body, function (this: unknown, key: string, value: unknown) {
    return key === 'data' && this && typeof this === 'object' && media.get(this) === 'image' ? '' : value;
  }) ?? '';
  const strictInputTokens = Buffer.byteLength(serialized, 'utf8') + images * STRICT_IMAGE_TOKENS
    + BASE_OVERHEAD_TOKENS + tools.length * PER_TOOL_TOKENS;

  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    maxTokens,
    fast,
    usOnly: body.inference_geo === 'us',
    stream: body.stream === true,
    inputTokens: Math.ceil(textTok) + images * IMAGE_TOKENS + Math.ceil(docBytes / 40) + urlDocs * URL_DOCUMENT_TOKENS
      + BASE_OVERHEAD_TOKENS + tools.length * PER_TOOL_TOKENS + webSearches * PER_SEARCH_TOKENS,
    strictInputTokens,
    webSearches,
    extraRuns,
  };
}

function runCost(model: string | undefined, inputTokens: number, maxTokens: number, fast: boolean): number {
  const p = priceFor(model);
  const tier = p.long && p.longPromptThreshold && inputTokens > p.longPromptThreshold ? p.long : p;
  const inFactor = fast && p.fastInput ? p.fastInput / p.input : 1;
  const outFactor = fast && p.fastOutput ? p.fastOutput / p.output : 1;
  return (inputTokens * tier.write1h * inFactor + maxTokens * tier.output * outFactor) / 1_000_000;
}

/**
 * Upper-bound cost in USD: every prompt token at the 1-hour cache-write price (the
 * dearest input rate), every allowed output token, plus each allowed advisor call
 * and fallback attempt at its own model's prices.
 */
export function reserveUsd(shape: RequestShape, strict = false): number {
  const input = strict ? Math.max(shape.strictInputTokens, shape.inputTokens) : shape.inputTokens;
  let usd = runCost(shape.model, input, shape.maxTokens, shape.fast);
  for (const run of shape.extraRuns) usd += runCost(run.model, input, run.maxTokens, run.fast) * run.count;
  return usd * (shape.usOnly ? 1.1 : 1) + shape.webSearches * WEB_SEARCH_USD;
}

/** Tool types the app runs itself: Anthropic only produces the tool call, so they add no server-side cost. */
const CLIENT_TOOL_TYPE = /^(custom|bash_\d+|text_editor_\d+|computer_\d+|memory_\d+)$/;

/**
 * Why the worst-case estimate is NOT a hard bound for this request, if it is not.
 *
 * The estimate is good enough to spread credit across accounts (Anthropic's own empty-balance stop is the final guard
 * there), but HUB_PAID_MONTHLY_CAP_USD promises a real limit on money. So, when the cap is set, the paid key only takes
 * requests whose cost the hub can bound: a known model, client-side tools only, and no content Anthropic fetches or
 * expands on its own (server tools such as web_fetch / web_search / code execution / advisor, MCP servers, containers,
 * documents by URL or file id, PDFs, server-side fallbacks to an unknown model).
 * An empty list means the estimate bounds the cost.
 */
export function unboundedReasons(body: Record<string, unknown>, shape: RequestShape = shapeOf(body)): string[] {
  const reasons = new Set<string>();
  if (priceFor(shape.model).family === 'unknown') reasons.add(`unknown model ${String(shape.model ?? '(none)')}`);
  for (const run of shape.extraRuns) {
    if (priceFor(run.model).family === 'unknown') reasons.add(`fallback/advisor to ${run.model ?? 'default routing'}`);
  }
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
  for (const t of tools) {
    const type = typeof t?.type === 'string' ? t.type : undefined;
    if (type !== undefined && !CLIENT_TOOL_TYPE.test(type)) reasons.add(`server tool ${type}`);
  }
  if (Array.isArray(body.mcp_servers) ? body.mcp_servers.length > 0 : body.mcp_servers != null) reasons.add('mcp_servers');
  if (body.container != null) reasons.add('container');
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const src = o.source as Record<string, unknown> | undefined;
    if (o.type === 'document' && src && typeof src === 'object') {
      if (src.type === 'url' || src.type === 'file') reasons.add(`document by ${String(src.type)}`);
      else if (src.type === 'base64' && String(src.media_type ?? '') !== 'text/plain') reasons.add('PDF document');
    }
    if (o.type === 'container_upload') reasons.add('container_upload');
    for (const x of Object.values(o)) walk(x);
  };
  walk(body.messages);
  walk(body.system);
  return [...reasons];
}
