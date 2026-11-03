/**
 * Reads token usage out of a streamed Messages API reply as it passes through.
 *
 * `message_start` carries the prompt usage and the serving model; each
 * `message_delta` carries running totals. Only `message_stop` proves the reply
 * finished; without it the caller treats the cost as uncertain.
 */

import { textTokens } from './estimate';
import type { Usage } from './pricing';

export class UsageTap {
  usage: Usage = {};
  model?: string;
  /** True once `message_stop` arrived: the usage totals are final. */
  complete = false;
  private streamedTokens = 0;
  private buffer = '';
  private decoder = new TextDecoder();

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith('data:')) this.onData(line.slice(5).trim());
    }
  }

  private onData(raw: string): void {
    if (!raw || raw[0] !== '{') return;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw); } catch { return; }
    if (ev.type === 'message_start') {
      const msg = ev.message as { usage?: Usage; model?: string } | undefined;
      if (msg?.usage) this.usage = { ...msg.usage };
      if (typeof msg?.model === 'string') this.model = msg.model;
    } else if (ev.type === 'message_delta') {
      const u = ev.usage as Usage | undefined;
      if (u) {
        for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) (this.usage as Record<string, unknown>)[k] = v;
      }
    } else if (ev.type === 'message_stop') {
      this.complete = true;
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta as Record<string, unknown> | undefined;
      for (const key of ['text', 'thinking', 'partial_json']) {
        const s = d?.[key];
        if (typeof s === 'string') this.streamedTokens += textTokens(s);
      }
    }
  }

  /** Usage to bill: the API's own totals, or a high guess when the stream ended early. */
  finalUsage(): Usage {
    if (this.complete) return this.usage;
    const guessed = Math.ceil(this.streamedTokens) + 50;
    return { ...this.usage, output_tokens: Math.max(this.usage.output_tokens ?? 0, guessed) };
  }
}
