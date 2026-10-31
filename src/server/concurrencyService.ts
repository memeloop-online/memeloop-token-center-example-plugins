import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  ADVICE_PATH, CONCURRENCY_PATH, REQUESTS_PATH, computeAdvice, decodeConcurrency, decodeOutcome,
  evidencePolicy, object, type AdviceSnapshot, type ConcurrencyObservation, type EvidencePolicy, type RequestOutcome,
} from './concurrencyAdvice.js';

export interface ConcurrencyServiceOptions {
  /** Trusted deployment configuration. Never accepted from an HTTP caller or plugin manifest. */
  coreOrigin: string; tenantExternalId: string; serviceToken: string; readToken: string;
  policy?: Partial<EvidencePolicy>; pollIntervalMs?: number; maxRequestPages?: number;
  fetch?: typeof globalThis.fetch; now?: () => number;
}
function secret(value: string): boolean { return value.length >= 16 && value.length <= 8_192 && !/[\s\u0000-\u001f\u007f]/u.test(value); }

/** Background, fixed-tenant companion for the existing Health Intelligence Node server.
 * Installed Wasm components cannot yet read these private host APIs; see the contract document.
 */
export class ConcurrencyAdviceService {
  readonly tenant: string;
  readonly path = ADVICE_PATH;
  private readonly origin: string;
  private readonly serviceToken: string;
  private readonly readDigest: Buffer;
  private readonly policy: EvidencePolicy;
  private readonly interval: number;
  private readonly pages: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private observation: ConcurrencyObservation | undefined;
  private snapshot: AdviceSnapshot | undefined;
  private requests: RequestOutcome[] = [];
  private requestsTruncated = false;
  private readonly proxyBindings = new Map<string, { key: string; observedAt: number }>();
  private requestRecordsSeen = 0;
  private rejectedTerminalOutcomes = 0;
  private lastSuccess: number | null = null;
  private lastError: number | null = null;
  private state = 'awaiting_first_sample';

  constructor(options: ConcurrencyServiceOptions) {
    const origin = new URL(options.coreOrigin);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
      || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)))
      || !secret(options.serviceToken) || !secret(options.readToken) || options.readToken === options.serviceToken
      || !options.tenantExternalId || options.tenantExternalId.length > 256 || /[\u0000-\u001f\u007f]/u.test(options.tenantExternalId)) {
      throw new Error('invalid_private_concurrency_configuration');
    }
    this.origin = origin.origin;
    this.tenant = options.tenantExternalId;
    this.serviceToken = options.serviceToken;
    this.readDigest = createHash('sha256').update(`Bearer ${options.readToken}`).digest();
    this.policy = evidencePolicy(options.policy);
    this.interval = options.pollIntervalMs ?? 5_000;
    this.pages = options.maxRequestPages ?? 8;
    if (!Number.isSafeInteger(this.interval) || this.interval < 5_000 || this.interval > 60_000
      || !Number.isSafeInteger(this.pages) || this.pages < 1 || this.pages > 8) throw new Error('invalid_collection_budget');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > 8_200) return false;
    return timingSafeEqual(this.readDigest, createHash('sha256').update(header).digest());
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.pending;
  }

  /** Concurrent refresh calls share one bounded operation. Reads never initiate network traffic. */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async readCore(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, this.origin);
    url.searchParams.set('tenant_external_id', this.tenant);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { authorization: `Bearer ${this.serviceToken}`, accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('core_unavailable'); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 8_388_608) { await reader.cancel(); throw new Error('core_body_budget_exceeded'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  private async collect(): Promise<void> {
    this.controller = new AbortController();
    try {
      const observation = decodeConcurrency(await this.readCore(CONCURRENCY_PATH, {}, this.controller.signal), this.tenant, this.now());
      for (const [id, binding] of this.proxyBindings) {
        if (this.now() - binding.observedAt > observation.retention_ms) this.proxyBindings.delete(id);
      }
      for (const s of observation.series) {
        if (s.dimension !== 'network_proxy') continue;
        if (s.proxyEndpointKey) this.proxyBindings.set(s.identity, { key: s.proxyEndpointKey, observedAt: observation.observed_at ?? this.now() });
        else {
          const binding = this.proxyBindings.get(s.identity);
          if (binding) s.proxyEndpointKey = binding.key;
        }
      }
      while (this.proxyBindings.size > 512) this.proxyBindings.delete(this.proxyBindings.keys().next().value!);
      // Keep fresh counts even if outcome collection fails; old outcomes never produce a new recommendation.
      this.observation = observation;
      const earliest = observation.series.reduce((time, s) => s.points.reduce((t, p) => Math.min(t, p.observed_at), time), this.now());
      const params: Record<string, string> = { paged: 'true', limit: '500', from_created_at: String(Math.max(earliest, this.now() - observation.retention_ms)),
        to_created_at: String(this.now()) };
      const requests = new Map<string, RequestOutcome>();
      let truncated = false;
      let recordsSeen = 0;
      let rejectedTerminals = 0;
      const cursors = new Set<string>();
      for (let page = 0; page < this.pages; page++) {
        const payload = object(await this.readCore(REQUESTS_PATH, params, this.controller.signal));
        if (!payload || !Array.isArray(payload.requests) || payload.requests.length > 500
          || !Object.hasOwn(payload, 'next_cursor')) throw new Error('invalid_request_page');
        for (const raw of payload.requests) {
          recordsSeen++;
          const row = decodeOutcome(raw);
          if (row) requests.set(row.id, row);
          else if (['succeeded', 'failed', 'cancelled'].includes(String(object(raw)?.lifecycle_state))) rejectedTerminals++;
        }
        if (payload.next_cursor === null) { truncated = false; break; }
        const cursor = object(payload.next_cursor);
        if (!cursor || typeof cursor.before_created_at !== 'number' || !Number.isSafeInteger(cursor.before_created_at)
          || cursor.before_created_at < 0 || typeof cursor.before_id !== 'string'
          || !/^[0-9a-f-]{36}$/iu.test(cursor.before_id)) throw new Error('invalid_request_cursor');
        const key = JSON.stringify(cursor);
        if (cursors.has(key)) throw new Error('repeated_request_cursor');
        cursors.add(key);
        params.before_created_at = String(cursor.before_created_at);
        params.before_id = cursor.before_id;
        truncated = true;
      }
      this.requests = [...requests.values()];
      this.requestsTruncated = truncated;
      this.requestRecordsSeen = recordsSeen;
      this.rejectedTerminalOutcomes = rejectedTerminals;
      this.lastSuccess = this.now();
      this.state = 'ok';
    } catch {
      this.lastError = this.now();
      this.state = 'collection_failed';
    } finally {
      this.controller = undefined;
      if (this.observation) this.snapshot = computeAdvice(this.observation, this.requests, this.policy, this.now(), this.requestsTruncated);
    }
  }

  read(): AdviceSnapshot {
    const now = this.now();
    const observation = this.observation ?? { contract_version: 'upstream_concurrency_v1', observed_at: null, stale: true,
      sample_interval_ms: 5_000, retention_ms: 900_000, samples_truncated: false,
      metadata_gaps: { missing_account_samples: 0, missing_egress_samples: 0, invalid_egress_samples: 0 }, series: [] };
    const cached = this.snapshot ?? computeAdvice(observation, [], this.policy, now);
    // Statistical work runs in collect(). HTTP reads only project freshness onto its cache.
    const snapshot: AdviceSnapshot = { ...cached, generated_at: now, series: cached.series.map((s) => ({ ...s,
      trend: { ...s.trend }, sampling: { ...s.sampling, blockers: [...s.sampling.blockers] },
      buckets: s.buckets.map((b) => ({ ...b, evidence: { ...b.evidence, blockers: [...b.evidence.blockers] } })) })) };
    const concurrencyStale = observation.stale || observation.observed_at === null
      || now - observation.observed_at > observation.sample_interval_ms * 2;
    if (concurrencyStale) {
      snapshot.stale = true;
      for (const s of snapshot.series) {
        s.current = null;
        s.trend = { ...s.trend, direction: 'insufficient', delta: null };
        s.recommendation = null;
        s.status = 'observing';
        s.sampling.blockers.push('stale_observation');
        for (const b of s.buckets) {
          b.evidence.sufficient = false;
          if (!b.evidence.blockers.includes('stale_observation')) b.evidence.blockers.push('stale_observation');
        }
      }
    }
    snapshot.tenant_external_id = this.tenant;
    snapshot.collection = { last_success_at: this.lastSuccess, last_error_at: this.lastError, state: this.state,
      request_records_seen: this.requestRecordsSeen, terminal_outcomes_accepted: this.requests.length,
      terminal_outcomes_rejected: this.rejectedTerminalOutcomes };
    if (!this.observation) snapshot.observation.metadata_gaps = null;
    if (this.state !== 'ok' || this.lastSuccess === null || now - this.lastSuccess > this.interval * 2 || this.rejectedTerminalOutcomes > 0) {
      const blocker = this.rejectedTerminalOutcomes > 0 ? 'unattributed_or_invalid_terminal_outcomes' : 'outcome_collection_unavailable_or_stale';
      if (blocker === 'outcome_collection_unavailable_or_stale') snapshot.stale = true;
      for (const s of snapshot.series) {
        s.recommendation = null;
        s.status = 'observing';
        s.sampling.blockers.push(blocker);
        for (const b of s.buckets) {
          b.evidence.sufficient = false;
          b.evidence.blockers.push(blocker);
        }
      }
    }
    return snapshot;
  }
}
