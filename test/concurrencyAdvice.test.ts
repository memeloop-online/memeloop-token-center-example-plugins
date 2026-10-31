import { describe, expect, it } from 'vitest';
import { computeAdvice, decodeConcurrency, decodeOutcome, evidencePolicy,
  type ConcurrencyObservation, type RequestOutcome } from '../src/server/concurrencyAdvice.js';

const now = 900_000;
function observation(): ConcurrencyObservation {
  return { contract_version: 'upstream_concurrency_v1', observed_at: now, stale: false, sample_interval_ms: 5_000,
    retention_ms: 900_000, samples_truncated: false,
    metadata_gaps: { missing_account_samples: 0, missing_egress_samples: 0, invalid_egress_samples: 0 },
    series: [{ tenant_external_id: 'tenant-a', dimension: 'upstream_account', identity: 'account-a',
      measurement_basis: 'request_owner_live_lease', current: 1, sampled_peak: 5, sample_ids: [],
      points: Array.from({ length: 180 }, (_, i) => ({ observed_at: (i + 1) * 5_000,
        value: Math.floor((i + 1) / 6) % 2 === 0 ? 1 : 5, truncated: false })) }] };
}
function request(i: number, high = false): RequestOutcome {
  // Two load ranges interleave across the same observation window. These are fixtures, not measurements.
  const createdAt = 60_000 * (1 + i % 12) + (high ? 30_000 : 0);
  return { id: `request-${i}-${high}`, account: 'account-a', createdAt, endedAt: createdAt + 10_000,
    model: 'model-a', upstreamModel: 'model-a', protocol: 'openai_responses', route: 'route-a', success: true,
    latencyMs: high ? 5_000 : 10_000, generationMs: high ? 5_000 : 10_000, inputTokens: 64, outputTokens: 32,
    usageBasis: 'provider_reported' };
}
const policy = evidencePolicy();

describe('private concurrency evidence', () => {
  it('validates the actual v1 contract and rejects cross-tenant/future/duplicate data', () => {
    const raw = observation();
    expect(decodeConcurrency(raw, 'tenant-a', now).series).toHaveLength(1);
    expect(() => decodeConcurrency(raw, 'tenant-b', now)).toThrow();
    raw.series.push(raw.series[0]!);
    expect(() => decodeConcurrency(raw, 'tenant-a', now)).toThrow();
    expect(() => decodeConcurrency({ ...observation(), observed_at: now + 1 }, 'tenant-a', now)).toThrow();
    expect(() => evidencePolicy({ maxSuccessRateError: 0 })).toThrow();
    expect(() => evidencePolicy({ automaticLimit: 8 })).toThrow();
  });

  it('uses terminal execution, preserves unknown metrics, and never infers success from lease disappearance', () => {
    const row = { request_id: 'r', upstream_account_id: 'a', model: 'm', protocol: 'p', created_at: 10,
      completed_at: null, operational_terminal: { completed_at: 20 }, lifecycle_state: 'failed', duration_ms: null,
      generation_duration_ms: null, output_tokens: null, input_tokens: null, usage_basis: 'not_observed' };
    expect(decodeOutcome(row)).toMatchObject({ endedAt: 20, success: false, latencyMs: null, outputTokens: null });
    expect(decodeOutcome({ ...row, lifecycle_state: 'pending' })).toBeNull();
    expect(decodeOutcome({ ...row, operational_terminal: null })).toBeNull();
  });

  it('shows observation progress and unbounded uncertainty rather than a fixed suggestion', () => {
    const result = computeAdvice(observation(), [request(1)], policy, now);
    const s = result.series[0]!;
    expect(s.recommendation).toBeNull();
    expect(s.current).toBe(1);
    expect(s.buckets[0]!.samples).toBe(1);
    expect(s.buckets[0]!.latencyMs.upper).toBeNull();
    expect(s.buckets[0]!.evidence.remainingSamples).toBeGreaterThan(0);
    expect(s.buckets[0]!.evidence.sampleProgress).toBeLessThan(1);
    expect(result.experiment.enabled).toBe(false);
    expect(result.application_mode).toBe('manual_only');
  });

  it('offers only observed ranges supported by simultaneous intervals in comparable cohorts', () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => [request(i), request(i, true)]).flat();
    const result = computeAdvice(observation(), rows, policy, now);
    expect(result.series[0]!.recommendation).toMatchObject({ kind: 'observed_range_for_manual_review',
      concurrencyRange: { from: 5, to: 5 }, baselineRange: { from: 1, to: 1 } });
    expect(result.uncertainty.simultaneous_metric_intervals).toBe(6);
    const differentModels = rows.map((r) => r.generationMs === 5_000 ? { ...r, model: 'other' } : r);
    expect(computeAdvice(observation(), differentModels, policy, now).series[0]!.recommendation).toBeNull();
    const overlapping = rows.map((r) => ({ ...r, latencyMs: 10_000, generationMs: 10_000 }));
    expect(computeAdvice(observation(), overlapping, policy, now).series[0]!.recommendation).toBeNull();
  });

  it('keeps failures with missing usage in the success denominator', () => {
    const success = request(1);
    const failure = { ...request(2), success: false, outputTokens: null, inputTokens: null, usageBasis: null,
      upstreamModel: null, route: null };
    const buckets = computeAdvice(observation(), [success, failure], policy, now).series[0]!.buckets;
    expect(buckets).toHaveLength(2);
    expect(buckets.every((b) => b.successRate.value === 0.5 && b.successRate.samples === 2)).toBe(true);
  });

  it('blocks stale, truncated, incomplete and unsupported proxy recommendations', () => {
    const raw = observation();
    const rows = Array.from({ length: 2_000 }, (_, i) => [request(i), request(i, true)]).flat();
    expect(computeAdvice({ ...raw, stale: true }, rows, policy, now).series[0]).toMatchObject({ current: null, recommendation: null });
    expect(computeAdvice(raw, rows, policy, now, true).series[0]!.recommendation).toBeNull();
    expect(computeAdvice(raw, [{ ...request(1), endedAt: request(1).createdAt + 100 }], policy, now).series[0]!.coverage.excluded)
      .toHaveProperty('incomplete_or_truncated_lifetime_sampling', 1);
    raw.series[0]!.dimension = 'network_proxy';
    raw.series[0]!.measurement_basis = 'live_owner_with_unfinished_egress_attempt';
    const proxy = computeAdvice(raw, [request(1)], policy, now).series[0]!;
    expect(proxy.current).toBe(1);
    expect(proxy.buckets).toHaveLength(0);
    expect(proxy.coverage.excluded).toHaveProperty('missing_complete_proxy_outcome_attribution', 1);
    expect(proxy.recommendation).toBeNull();
  });
});
