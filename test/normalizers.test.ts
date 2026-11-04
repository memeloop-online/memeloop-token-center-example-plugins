import { describe, expect, it } from 'vitest';
import { InvalidPayloadError, normalizeAixHan, normalizeCodexRadar, normalizeDeepSwe } from '../src/server/normalizers.js';
import { fixture } from './testUtils.js';

describe('public source normalizers', () => {
  it('keeps only bounded, typed Codex Radar intelligence rows', () => {
    const result = normalizeCodexRadar(fixture('codexradar.json'));
    expect(result.sourceUpdatedAt).toBe('2026-09-07T06:58:38.000Z');
    expect(result.rows[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'medium', iq: 111 });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).not.toHaveProperty('raw');
  });

  it('normalizes DeepSWE rates and efficiency metrics', () => {
    const result = normalizeDeepSwe(fixture('deepswe.json'));
    expect(result.sourceUpdatedAt).toBe('2026-09-03T22:24:37.984Z');
    expect(result.rows[0]).toMatchObject({ model: 'gpt-6-astra', passRate: 0.7411504424778761, samples: 452 });
    expect(result.rows[0]?.averageCostUsd).toBeCloseTo(6.5237);
  });

  it('selects the newest AixHan provider check and maps its public status', () => {
    const result = normalizeAixHan(fixture('aixhan.json'));
    expect(result.rows[0]).toMatchObject({ name: 'Example Team pool', status: 'degraded', latencyMs: 33824 });
    expect(result.rows[0]?.checkedAt).toBe('2026-09-07T07:43:22.000Z');
    expect(result.sourceUpdatedAt).toBe('2026-09-07T07:43:22.000Z');
  });

  it('preserves a published DeepSWE row when the source does not specify reasoning effort', () => {
    const result = normalizeDeepSwe({ generated_at: '2026-09-22T06:27:15.860279+00:00', rows: [
      { model: 'kimi-k2-7-code', reasoning_effort: null, pass_rate: 0.3053097345132743, n_attempted: 452 },
    ] });
    expect(result.rows[0]).toMatchObject({ model: 'kimi-k2-7-code', effort: 'unspecified', passRate: 0.3053097345132743 });
    expect(result.sourceUpdatedAt).toBe('2026-09-22T06:27:15.860Z');
  });

  it('keeps distinct benchmark configurations and their published cost basis', () => {
    const result = normalizeDeepSwe({ rows: [
      { model: 'same', reasoning_effort: 'high', pass_rate: 0.8, harness: 'harness-a', config: 'run-a', provider: 'source-a', cost_basis: 'Published USD estimate' },
      { model: 'same', reasoning_effort: 'high', pass_rate: 0.7, harness: 'harness-b', config: 'run-b' },
    ] });
    expect(result.rows.map(row => row.key)).toEqual(['run-a', 'run-b']);
    expect(result.rows[0]).toMatchObject({ harness: 'harness-a', provider: 'source-a', costBasis: 'Published USD estimate' });
  });

  it('preserves bounded, ordered actual health checks without inventing missing latency', () => {
    const result = normalizeAixHan({ providerTimelines: [{ latest: {
      id: 'p', name: 'Provider', status: 'error', checkedAt: '2026-11-04T20:29:00Z', latencyMs: null,
    }, items: Array.from({ length: 9 }, (_, index) => ({
      id: 'p', name: 'Provider', status: 'operational', checkedAt: `2026-11-04T20:${String(29 - index).padStart(2, '0')}:00Z`, latencyMs: 1234,
    })) }] });
    const row = result.rows[0]!;
    expect(row.sample0At).toBe('2026-11-04T20:29:00.000Z');
    expect(row.sample0LatencyMs).toBeNull();
    expect(row.sample0Status).toBe('error');
    expect(row.sample5At).toBe('2026-11-04T20:24:00.000Z');
    expect(row).not.toHaveProperty('sample6At');
    expect(Object.keys(row).length).toBeLessThanOrEqual(32);
  });

  it('does not let malformed rows escape as client data', () => {
    const result = normalizeCodexRadar({ generated_at: '2026-09-07T00:00:00Z', comprehensive_points: [
      { model: '<img>', effort: 'low', iq: 10, samples: 1 },
      { model: 'missing-iq', effort: 'low', samples: 1 },
    ] });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.model).toBe('<img>');
    expect(normalizeCodexRadar({ comprehensive_points: [{ model: 'm', effort: 'high', iq: 100 }] }).rows[0]?.samples).toBeNull();
  });

  it('accepts explicit empty source collections', () => {
    expect(normalizeCodexRadar({ comprehensive_points: [] }).rows).toEqual([]);
    expect(normalizeDeepSwe({ rows: [] }).rows).toEqual([]);
    expect(normalizeAixHan({ providerTimelines: [] }).rows).toEqual([]);
  });

  it('rejects a missing expected source collection', () => {
    expect(() => normalizeCodexRadar({})).toThrow(InvalidPayloadError);
    expect(() => normalizeDeepSwe({})).toThrow(InvalidPayloadError);
    expect(() => normalizeAixHan({})).toThrow(InvalidPayloadError);
  });

  it('rejects non-empty source collections with no valid rows', () => {
    expect(() => normalizeCodexRadar({ comprehensive_points: [{ model: 'missing-fields' }] })).toThrow(InvalidPayloadError);
    expect(() => normalizeDeepSwe({ rows: [{ model: 'missing-fields' }] })).toThrow(InvalidPayloadError);
    expect(() => normalizeAixHan({ providerTimelines: [{ items: [{ name: 'missing-status' }] }] })).toThrow(InvalidPayloadError);
  });
});
