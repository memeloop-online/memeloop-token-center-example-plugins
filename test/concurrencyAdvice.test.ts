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

describe('actual proxy endpoint binding', () => {
  function selected(host = 'PROXY.Example', member = 'one') {
    return { kind: 'proxy', scheme: 'http', host, port: 8080, member_id: member, group_name: 'not-an-identity' };
  }
  function boundObservation() {
    const raw = observation();
    raw.series[0]!.dimension = 'network_proxy';
    raw.series[0]!.identity = 'core-blake3-identity';
    raw.series[0]!.measurement_basis = 'live_owner_with_unfinished_egress_attempt';
    raw.series[0]!.sample_ids = ['live-example'];
    return { ...raw, samples: [{ sample_id: 'live-example', tenant_external_id: 'tenant-a', source: 'request_owner',
      lease_state: 'live', egress_state: 'unfinished_attempt', selected_egress: selected() }] };
  }
  function proxyOutcome(i: number, high: boolean) {
    const r = request(i, high);
    const decoded = decodeOutcome({ request_id: r.id, created_at: r.createdAt, completed_at: r.endedAt,
      lifecycle_state: 'succeeded', upstream_account_id: r.account, model: r.model, upstream_model: r.upstreamModel,
      protocol: r.protocol, route_id: r.route, duration_ms: r.latencyMs, generation_duration_ms: r.generationMs,
      input_tokens: r.inputTokens, output_tokens: r.outputTokens, usage_basis: r.usageBasis,
      egress: { selected: selected('proxy.example', 'different-member') } });
    if (!decoded) throw new Error('invalid proxy fixture');
    return decoded;
  }

  it('uses examples only to bind identity and includes all final outcomes for the actual endpoint', () => {
    const decoded = decodeConcurrency(boundObservation(), 'tenant-a', now);
    const rows = Array.from({ length: 2_000 }, (_, i) => [proxyOutcome(i, false), proxyOutcome(i, true)]).flat();
    const result = computeAdvice(decoded, rows, policy, now);
    const proxy = result.series[0]!;
    expect(proxy.coverage.matchedRequests).toBe(4_000);
    expect(proxy.recommendation).toMatchObject({ concurrencyRange: { from: 5, to: 5 } });
    expect(JSON.stringify(result)).not.toContain('proxy.example');
    expect(JSON.stringify(result)).not.toContain('proxyEndpointKey');
    expect(JSON.stringify(result)).not.toContain('live-example');
    const missing = computeAdvice(decoded, [...rows, request(100)], policy, now).series[0]!;
    expect(missing.recommendation).toBeNull();
    expect(missing.buckets[0]!.evidence.blockers).toContain('missing_proxy_outcome_metadata_in_window');
  });

  it('rejects conflicting actual endpoint bindings and never guesses from proxy group names', () => {
    const raw = boundObservation();
    raw.series[0]!.sample_ids.push('other-endpoint');
    raw.samples.push({ ...raw.samples[0]!, sample_id: 'other-endpoint', selected_egress: selected('other.example') });
    expect(() => decodeConcurrency(raw, 'tenant-a', now)).toThrow('ambiguous_proxy_series_binding');
    const noEndpoint = boundObservation();
    noEndpoint.samples[0]!.selected_egress = { ...selected(), kind: 'unknown' };
    expect(decodeConcurrency(noEndpoint, 'tenant-a', now).series[0]!.proxyEndpointKey).toBeUndefined();
  });
});
