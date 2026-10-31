/** Private, descriptive statistics over MTC's existing read-only observations.
 * No function in this module changes routing, admission, or account settings.
 */
export const CONCURRENCY_PATH = '/internal/v1/upstream-concurrency';
export const REQUESTS_PATH = '/internal/v1/requests';
export const ADVICE_PATH = '/api/health-intelligence/concurrency-advice';

type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}
function numeric(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function count(value: unknown): value is number { return numeric(value) && Number.isSafeInteger(value); }
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export interface Point { observed_at: number; value: number; truncated: boolean }
export interface ConcurrencySeries {
  tenant_external_id: string; dimension: 'upstream_account' | 'network_proxy'; identity: string;
  measurement_basis: string; current: number | null; sampled_peak: number; points: Point[]; sample_ids: string[];
}
export interface ConcurrencyObservation {
  contract_version: 'upstream_concurrency_v1'; observed_at: number | null; stale: boolean;
  sample_interval_ms: number; retention_ms: number; samples_truncated: boolean;
  metadata_gaps: { missing_account_samples: number; missing_egress_samples: number; invalid_egress_samples: number };
  series: ConcurrencySeries[];
}

/** Select only nonsecret fields; never forward samples, egress endpoints or raw errors. */
export function decodeConcurrency(value: unknown, tenant: string, now: number): ConcurrencyObservation {
  const root = object(value);
  const gaps = object(root?.metadata_gaps);
  if (!root || root.contract_version !== 'upstream_concurrency_v1' || typeof root.stale !== 'boolean'
    || !(root.observed_at === null || count(root.observed_at)) || typeof root.samples_truncated !== 'boolean'
    || !count(root.sample_interval_ms) || root.sample_interval_ms < 1_000 || root.sample_interval_ms > 60_000
    || !count(root.retention_ms) || root.retention_ms > 900_000 || root.retention_ms < root.sample_interval_ms
    || !gaps || !count(gaps.missing_account_samples) || !count(gaps.missing_egress_samples) || !count(gaps.invalid_egress_samples)
    || !Array.isArray(root.series) || root.series.length > 512) throw new Error('invalid_concurrency_contract');
  const series: ConcurrencySeries[] = [];
  const keys = new Set<string>();
  for (const raw of root.series) {
    const s = object(raw);
    if (!s || s.tenant_external_id !== tenant || (s.dimension !== 'upstream_account' && s.dimension !== 'network_proxy')
      || !identifier(s.identity) || !identifier(s.measurement_basis) || !(s.current === null || count(s.current))
      || !count(s.sampled_peak) || !Array.isArray(s.points) || s.points.length > 180
      || !Array.isArray(s.sample_ids) || s.sample_ids.length > 8 || !s.sample_ids.every(identifier)) {
      throw new Error('invalid_or_cross_tenant_series');
    }
    const points: Point[] = [];
    for (const rawPoint of s.points) {
      const p = object(rawPoint);
      if (!p || !count(p.observed_at) || p.observed_at > now || !count(p.value) || typeof p.truncated !== 'boolean'
        || (points.length > 0 && p.observed_at <= points[points.length - 1]!.observed_at)) throw new Error('invalid_concurrency_points');
      points.push({ observed_at: p.observed_at, value: p.value, truncated: p.truncated });
    }
    const key = JSON.stringify([s.dimension, s.identity, s.measurement_basis]);
    if (keys.has(key)) throw new Error('duplicate_concurrency_series');
    keys.add(key);
    series.push({ tenant_external_id: tenant, dimension: s.dimension, identity: s.identity,
      measurement_basis: s.measurement_basis, current: s.current, sampled_peak: s.sampled_peak, points,
      sample_ids: s.sample_ids as string[] });
  }
  if (root.observed_at !== null && root.observed_at > now) throw new Error('future_observation');
  return { contract_version: 'upstream_concurrency_v1', observed_at: root.observed_at, stale: root.stale,
    sample_interval_ms: root.sample_interval_ms, retention_ms: root.retention_ms, samples_truncated: root.samples_truncated,
    metadata_gaps: { missing_account_samples: gaps.missing_account_samples, missing_egress_samples: gaps.missing_egress_samples,
      invalid_egress_samples: gaps.invalid_egress_samples }, series };
}

export interface RequestOutcome {
  id: string; createdAt: number; endedAt: number; account: string; model: string; upstreamModel: string | null;
  protocol: string; route: string | null; success: boolean; latencyMs: number | null;
  generationMs: number | null; inputTokens: number | null; outputTokens: number | null; usageBasis: string | null;
}
export function decodeOutcome(value: unknown): RequestOutcome | null {
  const r = object(value);
  const terminal = object(r?.operational_terminal);
  const endedAt = terminal?.completed_at ?? r?.completed_at;
  if (!r || !identifier(r.request_id) || !identifier(r.upstream_account_id) || !identifier(r.model) || !identifier(r.protocol)
    || !count(r.created_at) || !count(endedAt) || endedAt < r.created_at
    || !['succeeded', 'failed', 'cancelled'].includes(String(r.lifecycle_state))) return null;
  return { id: r.request_id, account: r.upstream_account_id, createdAt: r.created_at, endedAt,
    model: r.model, upstreamModel: identifier(r.upstream_model) ? r.upstream_model : null, protocol: r.protocol,
    route: identifier(r.route_id) ? r.route_id : null, success: r.lifecycle_state === 'succeeded',
    latencyMs: count(r.duration_ms) ? r.duration_ms : null,
    generationMs: count(r.generation_duration_ms) && r.generation_duration_ms > 0 ? r.generation_duration_ms : null,
    inputTokens: count(r.input_tokens) ? r.input_tokens : null, outputTokens: count(r.output_tokens) ? r.output_tokens : null,
    usageBasis: identifier(r.usage_basis) ? r.usage_basis : null };
}

export interface EvidencePolicy {
  /** Statistical evidence requirements, never customer concurrency limits. */
  confidenceLevel: number; maxSuccessRateError: number; minObservationMs: number;
  maxLatencyRelativeError: number; maxTpsRelativeError: number; successNonInferiorityMargin: number;
  concurrencyBucketWidth: number;
}
export const DEFAULT_EVIDENCE_POLICY: Readonly<EvidencePolicy> = Object.freeze({
  confidenceLevel: 0.95, maxSuccessRateError: 0.05, minObservationMs: 60_000,
  maxLatencyRelativeError: 0.25, maxTpsRelativeError: 0.25, successNonInferiorityMargin: 0.05,
  concurrencyBucketWidth: 4,
});
export function evidencePolicy(input: unknown = {}): EvidencePolicy {
  const config = object(input);
  if (!config || Object.keys(config).some((key) => !Object.hasOwn(DEFAULT_EVIDENCE_POLICY, key))) throw new Error('invalid_evidence_policy');
  const p = { ...DEFAULT_EVIDENCE_POLICY, ...config } as EvidencePolicy;
  if (!numeric(p.confidenceLevel) || p.confidenceLevel < 0.8 || p.confidenceLevel >= 1
    || !numeric(p.maxSuccessRateError) || p.maxSuccessRateError <= 0 || p.maxSuccessRateError > 0.25
    || !count(p.minObservationMs) || p.minObservationMs < 1_000 || p.minObservationMs > 900_000
    || !numeric(p.maxLatencyRelativeError) || p.maxLatencyRelativeError <= 0 || p.maxLatencyRelativeError > 1
    || !numeric(p.maxTpsRelativeError) || p.maxTpsRelativeError <= 0 || p.maxTpsRelativeError > 1
    || !numeric(p.successNonInferiorityMargin) || p.successNonInferiorityMargin > 0.1
    || !count(p.concurrencyBucketWidth) || p.concurrencyBucketWidth < 1 || p.concurrencyBucketWidth > 1_024) {
    throw new Error('invalid_evidence_policy');
  }
  return p;
}
export interface Estimate { value: number | null; lower: number | null; upper: number | null; samples: number }
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}
/** DKW CDF band inverted at 0.5. Null endpoints mean unbounded, never zero error. */
function medianEstimate(values: number[], alpha: number): Estimate {
  values.sort((a, b) => a - b);
  const n = values.length;
  const epsilon = n ? Math.sqrt(Math.log(2 / alpha) / (2 * n)) : 1;
  const lowerRank = Math.ceil(n * (0.5 - epsilon)) - 1;
  const upperRank = Math.ceil(n * (0.5 + epsilon)) - 1;
  return { value: median(values), samples: n, lower: lowerRank >= 0 ? values[lowerRank] ?? null : null,
    upper: upperRank < n ? values[upperRank] ?? null : null };
}
function tokenBand(n: number | null): string {
  if (n === null) return 'unknown';
  if (n === 0) return '0';
  const low = 2 ** Math.floor(Math.log2(n));
  return `${low}-${low * 2 - 1}`;
}
function sufficient(e: Estimate, relative: number): boolean {
  return e.value !== null && e.value > 0 && e.lower !== null && e.upper !== null
    && (e.upper - e.lower) / (2 * e.value) <= relative;
}
export interface Cohort {
  account: string; model: string; upstreamModel: string | null; protocol: string; route: string | null;
  usageBasis: string | null; inputTokenBand: string; outputTokenBand: string;
}
interface BucketWork { cohort: Cohort; from: number; to: number; rows: { r: RequestOutcome; concurrency: number }[] }
export interface AdviceBucket {
  cohort: Cohort; concurrency: { from: number; to: number; observedMin: number; observedMax: number };
  samples: number; metricCohortSamples: number; successes: number; failures: number; observedFrom: number; observedTo: number; observationMs: number;
  successRate: Estimate; latencyMs: Estimate; generationTps: Estimate;
  evidence: { sufficient: boolean; blockers: string[]; targetSamples: number; remainingSamples: number;
    sampleProgress: number; windowProgress: number; successRateError: number };
}
export interface SeriesAdvice {
  dimension: ConcurrencySeries['dimension']; identity: string; measurement_basis: string;
  current: number | null; sampled_peak: number; points: Point[];
  trend: { direction: 'rising' | 'falling' | 'flat' | 'insufficient'; delta: number | null; from: number | null; to: number | null };
  buckets: AdviceBucket[];
  coverage: { terminalRequests: number; matchedRequests: number; excluded: Record<string, number> };
  status: 'observing' | 'inconclusive' | 'manual_review';
  recommendation: null | { kind: 'observed_range_for_manual_review'; concurrencyRange: { from: number; to: number };
    cohort: Cohort; baselineRange: { from: number; to: number }; reason: string };
}
export interface AdviceSnapshot {
  contract_version: 'health_concurrency_advice_v1'; generated_at: number; tenant_external_id: string;
  observed_at: number | null; stale: boolean; application_mode: 'manual_only'; policy: EvidencePolicy;
  observation: { sample_interval_ms: number | null; retention_ms: number | null; requests_truncated: boolean;
    samples_truncated: boolean; metadata_gaps: ConcurrencyObservation['metadata_gaps'] | null };
  uncertainty: { method: string; confidence_level: number; simultaneous_metric_intervals: number; assumptions: string[] };
  experiment: { enabled: false; state: 'disabled'; reason: string };
  limitations: string[]; collection: { last_success_at: number | null; last_error_at: number | null; state: string };
  series: SeriesAdvice[];
}

export function computeAdvice(observation: ConcurrencyObservation, requests: readonly RequestOutcome[], policy: EvidencePolicy,
  now: number, requestsTruncated = false): AdviceSnapshot {
  // Union bound across all reported metrics; per-request samples are still observational, not randomized trials.
  const work = observation.series.map((s) => {
    const excluded: Record<string, number> = {};
    const exclude = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
    const buckets = new Map<string, BucketWork>();
    let terminalRequests = 0;
    let matchedRequests = 0;
    for (const r of requests) {
      if (s.dimension === 'upstream_account' && r.account !== s.identity) continue;
      terminalRequests++;
      if (s.measurement_basis !== 'request_owner_live_lease' && s.measurement_basis !== 'live_owner_with_unfinished_egress_attempt') {
        exclude('generation_state_is_not_request_concurrency'); continue;
      }
      // Core only exposes bounded attribution examples, not a stable per-outcome proxy identity.
      // Historical request endpoints must not be guessed from configured proxy membership.
      if (s.dimension === 'network_proxy') { exclude('missing_complete_proxy_outcome_attribution'); continue; }
      const points = s.points.filter((p) => p.observed_at >= r.createdAt && p.observed_at <= r.endedAt);
      if (points.length < 2 || points[0]!.observed_at - r.createdAt > observation.sample_interval_ms
        || r.endedAt - points[points.length - 1]!.observed_at > observation.sample_interval_ms
        || points.some((p, i) => p.truncated || (i > 0 && p.observed_at - points[i - 1]!.observed_at > observation.sample_interval_ms * 2))) {
        exclude('incomplete_or_truncated_lifetime_sampling'); continue;
      }
      if (r.endedAt > now || r.createdAt < now - observation.retention_ms) { exclude('outside_observation_window'); continue; }
      const concurrency = Math.max(...points.map((p) => p.value));
      if (concurrency < 1) { exclude('no_positive_owner_observation'); continue; }
      const cohort: Cohort = { account: r.account, model: r.model, upstreamModel: r.upstreamModel, protocol: r.protocol,
        route: r.route, usageBasis: r.usageBasis, inputTokenBand: tokenBand(r.inputTokens), outputTokenBand: tokenBand(r.outputTokens) };
      const from = Math.floor((concurrency - 1) / policy.concurrencyBucketWidth) * policy.concurrencyBucketWidth + 1;
      const key = JSON.stringify([cohort, from]);
      let b = buckets.get(key);
      if (!b) { b = { cohort, from, to: from + policy.concurrencyBucketWidth - 1, rows: [] }; buckets.set(key, b); }
      b.rows.push({ r, concurrency }); matchedRequests++;
    }
    return { s, buckets: [...buckets.values()], excluded, terminalRequests, matchedRequests };
  });
  const intervals = Math.max(1, work.reduce((n, w) => n + w.buckets.length * 3, 0));
  const alpha = (1 - policy.confidenceLevel) / intervals;
  const target = Math.ceil(Math.log(2 / alpha) / (2 * policy.maxSuccessRateError ** 2));
  const series = work.map(({ s, buckets: rawBuckets, excluded, terminalRequests, matchedRequests }): SeriesAdvice => {
    const buckets = rawBuckets.map((b): AdviceBucket => {
      // Success denominator never conditions on observed usage/output length. Otherwise
      // missing usage on failures would silently turn a failing bucket into 100% success.
      const denominator = rawBuckets.filter((other) => other.from === b.from && other.cohort.account === b.cohort.account
        && other.cohort.model === b.cohort.model && other.cohort.protocol === b.cohort.protocol).flatMap((other) => other.rows);
      const n = denominator.length;
      const successes = denominator.filter(({ r }) => r.success).length;
      const radius = Math.sqrt(Math.log(2 / alpha) / (2 * n));
      const latency = medianEstimate(b.rows.filter(({ r }) => r.success && r.latencyMs !== null).map(({ r }) => r.latencyMs!), alpha);
      const tps = medianEstimate(b.rows.filter(({ r }) => r.success && r.usageBasis === 'provider_reported'
        && r.outputTokens !== null && r.generationMs !== null).map(({ r }) => r.outputTokens! * 1_000 / r.generationMs!), alpha);
      const from = Math.min(...b.rows.map(({ r }) => r.createdAt));
      const to = Math.max(...b.rows.map(({ r }) => r.endedAt));
      const blockers: string[] = [];
      if (n < target) blockers.push('insufficient_success_rate_precision');
      if (to - from < policy.minObservationMs) blockers.push('observation_window_too_short');
      if (!sufficient(latency, policy.maxLatencyRelativeError)) blockers.push('insufficient_latency_precision');
      if (!sufficient(tps, policy.maxTpsRelativeError)) blockers.push('insufficient_provider_reported_generation_tps');
      if (b.cohort.inputTokenBand === 'unknown' || b.cohort.outputTokenBand === 'unknown' || b.cohort.route === null
        || b.cohort.upstreamModel === null) blockers.push('incomplete_comparability_metadata');
      if (observation.stale || observation.observed_at === null || now - observation.observed_at > observation.sample_interval_ms * 2) blockers.push('stale_observation');
      if (requestsTruncated || observation.samples_truncated) blockers.push('truncated_source');
      return { cohort: b.cohort, concurrency: { from: b.from, to: b.to,
        observedMin: Math.min(...b.rows.map((r) => r.concurrency)), observedMax: Math.max(...b.rows.map((r) => r.concurrency)) },
        samples: n, metricCohortSamples: b.rows.length, successes, failures: n - successes, observedFrom: from, observedTo: to, observationMs: to - from,
        successRate: { value: successes / n, lower: Math.max(0, successes / n - radius), upper: Math.min(1, successes / n + radius), samples: n },
        latencyMs: latency, generationTps: tps,
        evidence: { sufficient: blockers.length === 0, blockers, targetSamples: target, remainingSamples: Math.max(0, target - n),
          sampleProgress: Math.min(1, n / target), windowProgress: Math.min(1, (to - from) / policy.minObservationMs), successRateError: radius } };
    }).sort((a, b) => JSON.stringify(a.cohort).localeCompare(JSON.stringify(b.cohort)) || a.concurrency.from - b.concurrency.from);
    let recommendation: SeriesAdvice['recommendation'] = null;
    for (const baseline of buckets) {
      for (const candidate of buckets) {
        if (baseline === candidate || !baseline.evidence.sufficient || !candidate.evidence.sufficient
          || JSON.stringify(baseline.cohort) !== JSON.stringify(candidate.cohort)
          || Math.min(baseline.observedTo, candidate.observedTo) - Math.max(baseline.observedFrom, candidate.observedFrom) < policy.minObservationMs) continue;
        if (candidate.successRate.lower! < baseline.successRate.upper! - policy.successNonInferiorityMargin
          || candidate.latencyMs.upper! > baseline.latencyMs.lower! || candidate.generationTps.lower! < baseline.generationTps.upper!
          || (candidate.latencyMs.upper === baseline.latencyMs.lower && candidate.generationTps.lower === baseline.generationTps.upper)) continue;
        recommendation = { kind: 'observed_range_for_manual_review', concurrencyRange: {
          from: candidate.concurrency.observedMin, to: candidate.concurrency.observedMax }, cohort: candidate.cohort,
          baselineRange: { from: baseline.concurrency.observedMin, to: baseline.concurrency.observedMax },
          reason: 'comparable_observed_intervals_support_success_noninferiority_and_latency_tps_dominance' };
        break;
      }
      if (recommendation) break;
    }
    const fresh = !observation.stale && observation.observed_at !== null && now - observation.observed_at <= observation.sample_interval_ms * 2;
    const valid = s.points.filter((p) => !p.truncated);
    const half = Math.floor(valid.length / 2);
    const first = half ? median(valid.slice(0, half).map((p) => p.value).sort((a, b) => a - b)) : null;
    const last = half ? median(valid.slice(half).map((p) => p.value).sort((a, b) => a - b)) : null;
    const delta = fresh && first !== null && last !== null ? last - first : null;
    return { dimension: s.dimension, identity: s.identity, measurement_basis: s.measurement_basis,
      current: fresh ? s.current : null, sampled_peak: s.sampled_peak, points: s.points,
      trend: { direction: delta === null ? 'insufficient' : delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat', delta,
        from: valid[0]?.observed_at ?? null, to: valid[valid.length - 1]?.observed_at ?? null }, buckets,
      coverage: { terminalRequests, matchedRequests, excluded }, recommendation,
      status: recommendation ? 'manual_review' : buckets.some((b) => b.evidence.sufficient) ? 'inconclusive' : 'observing' };
  });
  return { contract_version: 'health_concurrency_advice_v1', generated_at: now, tenant_external_id: observation.series[0]?.tenant_external_id ?? '',
    observed_at: observation.observed_at, stale: observation.stale || observation.observed_at === null || now - observation.observed_at > observation.sample_interval_ms * 2,
    application_mode: 'manual_only', policy,
    observation: { sample_interval_ms: observation.sample_interval_ms, retention_ms: observation.retention_ms,
      requests_truncated: requestsTruncated, samples_truncated: observation.samples_truncated, metadata_gaps: observation.metadata_gaps },
    uncertainty: { method: 'hoeffding_success_rate_dkw_median_union_bound', confidence_level: policy.confidenceLevel,
      simultaneous_metric_intervals: intervals, assumptions: ['iid_within_cohort_required_for_nominal_coverage', 'observational_not_causal',
        'adaptive_repeated_looks_not_sequentially_valid', 'latency_and_tps_conditioned_on_success'] },
    experiment: { enabled: false, state: 'disabled', reason: 'no_isolated_budgeted_experiment_executor_in_current_host_contract' },
    limitations: ['sampled_owner_concurrency_is_not_wire_concurrency_or_a_limit', 'short_requests_and_incomplete_lifetimes_are_excluded_selection_bias',
      'streaming_retry_transport_revision_and_prompt_mix_are_not_controlled', 'output_token_strata_are_descriptive_post_outcome_groups', 'success_denominator_is_all_account_model_protocol_outcomes_in_concurrency_bucket',
      'proxy_outcome_identity_missing_no_proxy_recommendation', 'success_is_terminal_lifecycle_not_lease_disappearance',
      'generation_tps_uses_only_provider_reported_output_tokens_and_generation_duration_ms', 'process_local_15_minute_history_and_sampled_peak_lower_bound'],
    collection: { last_success_at: now, last_error_at: null, state: 'ok' }, series };
}
