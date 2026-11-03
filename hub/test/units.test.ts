import { describe, expect, it } from 'vitest';
import { cycleFor, monthCycle } from '@/lib/cycle';
import { reserveUsd, shapeOf } from '@/lib/estimate';
import { costOf, priceFor } from '@/lib/pricing';
import { UsageTap } from '@/lib/sse';

describe('pricing', () => {
  it('matches model ids, including dated ones', () => {
    expect(priceFor('claude-opus-5-5').family).toBe('opus-5.5');
    expect(priceFor('claude-opus-5-20261001').family).toBe('opus-5');
    expect(priceFor('claude-opus-4-8').family).toBe('opus-4.8');
    expect(priceFor('claude-opus-4-1-20250805').family).toBe('opus-4-4.1');
    expect(priceFor('claude-sonnet-5-5').family).toBe('sonnet-5.5');
    expect(priceFor('claude-sonnet-4-5-20250929').family).toBe('sonnet-4.x');
    expect(priceFor('claude-haiku-4-5-20251001').family).toBe('haiku-4.5');
    expect(priceFor('claude-fable-5-1').family).toBe('fable-5.1');
    expect(priceFor('something-new').family).toBe('unknown');
  });

  it('prices every token category', () => {
    // Opus 5.5: 1M input $4, 1M output $20, 1M 1h write $8, 1M read $0.20, plus 3 searches.
    const cost = costOf({
      input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      server_tool_use: { web_search_requests: 3 },
    }, { model: 'claude-opus-5-5' });
    expect(cost).toBeCloseTo(4 + 20 + 8 + 0.2 + 0.03, 6);
  });

  it('prices each sub-inference at its own model (Anthropic advisor example)', () => {
    const usage = {
      input_tokens: 1760, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 531,
      iterations: [
        { type: 'message', input_tokens: 412, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 89 },
        { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 823, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1612 },
        { type: 'message', input_tokens: 1348, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 442 },
      ],
    };
    // Executor Sonnet 5.5: 1760 in × $2 + 412 read × $0.10 + 531 out × $10; advisor Opus 5.5: 823 × $4 + 1612 × $20.
    const expected = (1760 * 2 + 412 * 0.1 + 531 * 10 + 823 * 4 + 1612 * 20) / 1e6;
    expect(costOf(usage, { model: 'claude-sonnet-5-5' })).toBeCloseTo(expected, 9);
  });

  it('prices a fast fallback attempt at fast rates', () => {
    const usage = { iterations: [{ type: 'fallback_message', model: 'claude-opus-4-8', speed: 'fast', input_tokens: 1000, output_tokens: 1000 }] };
    expect(costOf(usage, { model: 'claude-fable-5' })).toBeCloseTo((1000 * 10 + 1000 * 50) / 1e6, 9);
  });

  it('prices a server-side fallback reply at the model that served it', () => {
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    expect(costOf(usage, { model: 'claude-haiku-5-5', servedModel: 'claude-opus-4-8' })).toBeCloseTo((1000 * 5 + 1000 * 25) / 1e6, 9);
  });

  it('applies fast mode, US-only inference, and Haiku 5.5 long prompts', () => {
    expect(costOf({ input_tokens: 1e6, output_tokens: 1e6 }, { model: 'claude-opus-5-5', fast: true })).toBeCloseTo(48, 6);
    expect(costOf({ input_tokens: 1e6 }, { model: 'claude-sonnet-5-5', usOnly: true })).toBeCloseTo(2.2, 6);
    expect(costOf({ input_tokens: 50_000 }, { model: 'claude-haiku-5-5' })).toBeCloseTo(0.005, 9);
    expect(costOf({ input_tokens: 150_000 }, { model: 'claude-haiku-5-5' })).toBeCloseTo(0.075, 9);
  });
});

describe('billing cycle', () => {
  it('runs from the latest billing day to the next', () => {
    const c = cycleFor(14, new Date('2026-10-16T03:00:00Z'), 'Asia/Seoul');
    expect([c.start, c.end]).toEqual(['2026-10-14', '2026-11-14']);
    const before = cycleFor(20, new Date('2026-10-16T03:00:00Z'), 'Asia/Seoul');
    expect([before.start, before.end]).toEqual(['2026-09-20', '2026-10-20']);
  });

  it('uses the last day of short months', () => {
    const c = cycleFor(31, new Date('2027-02-15T00:00:00Z'), 'Asia/Seoul');
    expect([c.start, c.end]).toEqual(['2027-01-31', '2027-02-28']);
    const leap = cycleFor(30, new Date('2028-03-01T12:00:00Z'), 'UTC');
    expect([leap.start, leap.end]).toEqual(['2028-02-29', '2028-03-30']);
  });

  it('switches at midnight Korea time in Asia/Seoul', () => {
    // 2026-10-13 15:30 UTC is 2026-10-14 00:30 KST: the new cycle has begun.
    expect(cycleFor(14, new Date('2026-10-13T15:30:00Z'), 'Asia/Seoul').start).toBe('2026-10-14');
    expect(cycleFor(14, new Date('2026-10-13T14:30:00Z'), 'Asia/Seoul').start).toBe('2026-09-14');
    const c = cycleFor(14, new Date('2026-10-13T15:30:00Z'), 'Asia/Seoul');
    expect(c.startsAt.toISOString()).toBe('2026-10-13T15:00:00.000Z');
    expect(c.endsAt.toISOString()).toBe('2026-11-13T15:00:00.000Z');
  });

  it('switches at midnight UTC in UTC (the default)', () => {
    expect(cycleFor(14, new Date('2026-10-13T23:59:59Z'), 'UTC').start).toBe('2026-09-14');
    expect(cycleFor(14, new Date('2026-10-14T00:00:00Z'), 'UTC').start).toBe('2026-10-14');
    expect(cycleFor(14, new Date('2026-10-14T00:00:00Z'), 'UTC').startsAt.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    const saved = process.env.HUB_TIMEZONE;
    delete process.env.HUB_TIMEZONE;
    try {
      expect(cycleFor(14, new Date('2026-10-14T00:00:00Z')).startsAt.toISOString()).toBe('2026-10-14T00:00:00.000Z');
      process.env.HUB_TIMEZONE = 'Not/AZone';
      expect(cycleFor(14, new Date('2026-10-14T00:00:00Z')).startsAt.toISOString()).toBe('2026-10-14T00:00:00.000Z');
      process.env.HUB_TIMEZONE = 'Asia/Seoul';
      expect(cycleFor(14, new Date('2026-10-13T15:30:00Z')).start).toBe('2026-10-14');
    } finally {
      if (saved === undefined) delete process.env.HUB_TIMEZONE; else process.env.HUB_TIMEZONE = saved;
    }
  });

  it('switches at local midnight in America/Los_Angeles, across daylight saving', () => {
    const tz = 'America/Los_Angeles';
    // PDT (UTC-7): 2026-10-14 00:00 local is 07:00 UTC.
    expect(cycleFor(14, new Date('2026-10-14T06:59:00Z'), tz).start).toBe('2026-09-14');
    expect(cycleFor(14, new Date('2026-10-14T07:00:00Z'), tz).start).toBe('2026-10-14');
    expect(cycleFor(14, new Date('2026-10-14T07:00:00Z'), tz).startsAt.toISOString()).toBe('2026-10-14T07:00:00.000Z');
    // The cycle ends on 2026-11-14, after the switch to PST (UTC-8) on 2026-11-01: 08:00 UTC.
    expect(cycleFor(14, new Date('2026-10-14T07:00:00Z'), tz).endsAt.toISOString()).toBe('2026-11-14T08:00:00.000Z');
    // On the day clocks go back (2026-11-01), the day still begins at local midnight (PDT, 07:00 UTC).
    expect(cycleFor(1, new Date('2026-11-01T12:00:00Z'), tz).startsAt.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    // Spring forward (2027-03-14): midnight is still PST, 08:00 UTC; the next day begins at 07:00 UTC.
    expect(cycleFor(14, new Date('2027-03-14T12:00:00Z'), tz).startsAt.toISOString()).toBe('2027-03-14T08:00:00.000Z');
    expect(cycleFor(15, new Date('2027-03-15T07:00:00Z'), tz).start).toBe('2027-03-15');
    expect(cycleFor(15, new Date('2027-03-15T06:59:00Z'), tz).start).toBe('2027-02-15');
  });

  it('finds the first moment of a day whose midnight is skipped by daylight saving', () => {
    // America/Santiago moves clocks from 24:00 to 01:00 on 2026-09-06: that day begins at 01:00 local (04:00 UTC).
    const c = cycleFor(6, new Date('2026-09-10T12:00:00Z'), 'America/Santiago');
    expect(c.start).toBe('2026-09-06');
    expect(c.startsAt.toISOString()).toBe('2026-09-06T04:00:00.000Z');
  });

  it('groups paid use by calendar month in the hub time zone', () => {
    expect(monthCycle(new Date('2026-10-31T16:00:00Z'), 'Asia/Seoul').start).toBe('2026-11-01');
    expect(monthCycle(new Date('2026-10-31T16:00:00Z'), 'UTC').start).toBe('2026-10-01');
    expect(monthCycle(new Date('2026-11-01T03:00:00Z'), 'America/Los_Angeles').start).toBe('2026-10-01');
  });
});

describe('cost estimate before sending', () => {
  it('is at least the real cost of a full-length reply', () => {
    const body = { model: 'claude-opus-5-5', max_tokens: 2000, messages: [{ role: 'user', content: '안녕하세요'.repeat(200) }] };
    const shape = shapeOf(body);
    // 1,000 Korean characters, at a worst case of 1.3 tokens each.
    const real = costOf({ input_tokens: 1300, output_tokens: 2000 }, { model: body.model });
    expect(reserveUsd(shape)).toBeGreaterThanOrEqual(real);
  });

  it('covers 1-hour cache writes, advisor calls and fallbacks', () => {
    const base = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(3000) }] };
    const plain = reserveUsd(shapeOf(base));
    // Every prompt token written to the 1-hour cache ($4/M on Sonnet 5.5) plus the full 1,000 output tokens.
    expect(plain).toBeGreaterThanOrEqual(costOf({ cache_creation_input_tokens: 2000, output_tokens: 1000 }, { model: base.model }));
    const withAdvisor = reserveUsd(shapeOf({ ...base, tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_uses: 1, max_tokens: 2000 }] }));
    expect(withAdvisor - plain).toBeGreaterThanOrEqual((2000 * 20) / 1e6);
    const withFallback = reserveUsd(shapeOf({ ...base, fallbacks: [{ model: 'claude-opus-4-8' }] }));
    expect(withFallback - plain).toBeGreaterThanOrEqual((1000 * 25) / 1e6);
  });

  it('bounds advisor calls, honours fallback overrides, and stays small for huge max_uses', () => {
    const base = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] };
    const unlimited = shapeOf({ ...base, tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5' }] });
    expect(unlimited.extraRuns).toEqual([{ model: 'claude-opus-5-5', maxTokens: 32_000, fast: false, count: 10 }]);
    const huge = shapeOf({ ...base, tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_uses: 1e12 }] });
    expect(huge.extraRuns[0].count).toBe(1e12);
    expect(reserveUsd(huge)).toBeGreaterThan(1e6);
    const fb = shapeOf({ ...base, fallbacks: [{ model: 'claude-opus-4-8', max_tokens: 64_000, speed: 'fast' }] });
    // 64k output at Opus 4.8 fast rates ($50/M) alone is $3.20.
    expect(reserveUsd(fb)).toBeGreaterThanOrEqual(3.2);
    expect(shapeOf({ ...base, fallbacks: 'default' }).extraRuns[0].model).toBeUndefined();
  });

  it('counts images by number, not base64 length', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_000_000) } };
    const shape = shapeOf({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: [img] }] });
    expect(shape.inputTokens).toBeLessThan(4_000);
  });
});

describe('stream usage reader', () => {
  const enc = new TextEncoder();
  it('takes prompt usage from message_start and totals from message_delta, across chunk splits', () => {
    const tap = new UsageTap();
    const text = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":45,"server_tool_use":{"web_search_requests":1}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const bytes = enc.encode(text);
    for (let i = 0; i < bytes.length; i += 7) tap.push(bytes.slice(i, i + 7));
    expect(tap.finalUsage()).toMatchObject({ input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 45, server_tool_use: { web_search_requests: 1 } });
  });

  it('guesses output high when the stream stops before the totals', () => {
    const tap = new UsageTap();
    tap.push(enc.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n'));
    tap.push(enc.encode(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${'가'.repeat(400)}"}}\n`));
    expect(tap.finalUsage().output_tokens).toBeGreaterThanOrEqual(200);
  });
});
