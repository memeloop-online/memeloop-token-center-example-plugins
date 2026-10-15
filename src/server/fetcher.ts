import type {
  HealthIntelligenceSnapshot,
  SourceId,
  SourceSnapshot,
} from '../shared/types.js';
import { InvalidPayloadError } from './normalizers.js';
import { refreshSourceStatus } from '../shared/freshness.js';
import { normalizedRows } from '../shared/rows.js';
import {
  assertExactAllowedOrigin,
  parseRobots,
  robotsUnavailable,
  type RobotsRules,
} from './security.js';
import { createSourceRegistry, SOURCE_REGISTRY, type SourceSpec } from './sources.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type FetchFailureCode =
  | 'timeout'
  | 'network'
  | 'http_4xx'
  | 'http_5xx'
  | 'body_too_large'
  | 'not_json'
  | 'invalid_payload'
  | 'robots_denied'
  | 'robots_unavailable';

export class SourceFetchError extends Error {
  readonly code: FetchFailureCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly attempts: number;

  constructor(code: FetchFailureCode, message: string, retryable: boolean, status: number | null = null, attempts = 0) {
    super(message);
    this.name = 'SourceFetchError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.attempts = attempts;
  }
}

export interface FetchPolicy {
  readonly timeoutMs: number;
  readonly retries: number;
  readonly bodyCapBytes: number;
  readonly robotsBodyCapBytes: number;
  readonly retryDelayMs: readonly number[];
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = Object.freeze({
  timeoutMs: 4_000,
  retries: 2,
  bodyCapBytes: 2 * 1024 * 1024,
  robotsBodyCapBytes: 64 * 1024,
  retryDelayMs: [100, 300],
});

export interface SnapshotServiceOptions {
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly policy?: Partial<FetchPolicy>;
  readonly cacheTtlMs?: number;
  readonly failureCacheTtlMs?: number;
  readonly initialSnapshot?: HealthIntelligenceSnapshot;
  readonly sources?: readonly SourceSpec[];
}

interface ResolvedSnapshotOptions {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly policy: FetchPolicy;
  readonly cacheTtlMs: number;
  readonly allowedOrigins: ReadonlySet<string>;
}

interface CachedSource {
  readonly sourceUpdatedAt: string | null;
  readonly fetchedAt: string;
  readonly rows: SourceSnapshot['rows'];
}

interface DataResponse {
  readonly body: unknown;
  readonly attempts: number;
}

const USER_AGENT = 'mtc-health-intelligence/1.0 (public-readonly; +https://github.com/memeloop-online/memeloop-token-center-example-plugins)';
const MAX_RETRY_AFTER_MS = 2_000;

function mergePolicy(policy: Partial<FetchPolicy> | undefined): FetchPolicy {
  const merged = {
    ...DEFAULT_FETCH_POLICY,
    ...policy,
    retryDelayMs: policy?.retryDelayMs ?? DEFAULT_FETCH_POLICY.retryDelayMs,
  };
  if (!Number.isInteger(merged.timeoutMs) || merged.timeoutMs < 100 || merged.timeoutMs > 30_000) {
    throw new Error('timeoutMs must be between 100 and 30000');
  }
  if (!Number.isInteger(merged.retries) || merged.retries < 0 || merged.retries > 3) {
    throw new Error('retries must be between 0 and 3');
  }
  if (!Number.isInteger(merged.bodyCapBytes) || merged.bodyCapBytes < 1_024 || merged.bodyCapBytes > 8 * 1024 * 1024) {
    throw new Error('bodyCapBytes is outside the safe range');
  }
  if (!Number.isInteger(merged.robotsBodyCapBytes) || merged.robotsBodyCapBytes < 1_024 || merged.robotsBodyCapBytes > 256 * 1024) {
    throw new Error('robotsBodyCapBytes is outside the safe range');
  }
  return Object.freeze(merged);
}

function defaultFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
}

async function readBodyWithCap(response: Response, capBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > capBytes) {
      throw new SourceFetchError('body_too_large', 'public source response exceeded the body limit', false);
    }
  }
  if (!response.body) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > capBytes) {
      throw new SourceFetchError('body_too_large', 'public source response exceeded the body limit', false);
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > capBytes) {
        await reader.cancel();
        throw new SourceFetchError('body_too_large', 'public source response exceeded the body limit', false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function fetchResponse(
  url: string,
  options: ResolvedSnapshotOptions,
  capBytes: number,
  acceptedContentType: 'json' | 'robots',
): Promise<{ response: Response; body: string; attempts: number }> {
  assertExactAllowedOrigin(url, options.allowedOrigins);
  let lastError: SourceFetchError | undefined;
  for (let attempt = 0; attempt <= options.policy.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.policy.timeoutMs);
    try {
      const response = await options.fetch(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          accept: acceptedContentType === 'json' ? 'application/json' : 'text/plain',
          'user-agent': USER_AGENT,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        const code: FetchFailureCode = response.status >= 500 ? 'http_5xx' : 'http_4xx';
        // Consume and discard the bounded error body. It is never returned to
        // the caller, and this allows pooled connections to be reused.
        try {
          await readBodyWithCap(response, Math.min(capBytes, 16 * 1024));
        } catch {
          // The status is sufficient for the public error classification.
        }
        clearTimeout(timeout);
        lastError = new SourceFetchError(code, `public source returned HTTP ${response.status}`, retryable, response.status);
        if (!retryable || attempt >= options.policy.retries) throw lastError;
        const delay = retryAfterMilliseconds(response)
          ?? options.policy.retryDelayMs[Math.min(attempt, options.policy.retryDelayMs.length - 1)]
          ?? 0;
        await options.sleep(Math.max(0, delay));
        continue;
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (acceptedContentType === 'json' && contentType.includes('text/html')) {
        throw new SourceFetchError('not_json', 'public data endpoint returned HTML', false);
      }
      // Some static sites route a missing /robots.txt to the HTML app shell.
      // That response contains no robots directives and is equivalent to a
      // missing robots file for this fixed, public JSON endpoint.
      if (acceptedContentType === 'robots' && contentType.includes('text/html')) {
        await response.body?.cancel();
        clearTimeout(timeout);
        return { response, body: '', attempts: attempt + 1 };
      }
      const body = await readBodyWithCap(response, capBytes);
      clearTimeout(timeout);
      return { response, body, attempts: attempt + 1 };
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof SourceFetchError) {
        lastError = new SourceFetchError(error.code, error.message, error.retryable, error.status, attempt + 1);
      } else if (controller.signal.aborted) {
        lastError = new SourceFetchError('timeout', 'public source request timed out', true, null, attempt + 1);
      } else {
        lastError = new SourceFetchError('network', 'public source request failed', true, null, attempt + 1);
      }
      if (!lastError.retryable || attempt >= options.policy.retries) throw lastError;
      const delay = options.policy.retryDelayMs[Math.min(attempt, options.policy.retryDelayMs.length - 1)] ?? 0;
      await options.sleep(Math.max(0, delay));
    }
  }
  throw lastError ?? new SourceFetchError('network', 'public source request failed', true);
}

async function fetchJson(
  url: string,
  options: ResolvedSnapshotOptions,
): Promise<DataResponse> {
  const result = await fetchResponse(url, options, options.policy.bodyCapBytes, 'json');
  try {
    return { body: JSON.parse(result.body) as unknown, attempts: result.attempts };
  } catch {
    throw new SourceFetchError('not_json', 'public data endpoint returned invalid JSON', false);
  }
}

async function fetchRobots(
  spec: SourceSpec,
  options: ResolvedSnapshotOptions,
): Promise<{ rules: RobotsRules; attempts: number }> {
  try {
    const result = await fetchResponse(spec.robotsUrl, options, options.policy.robotsBodyCapBytes, 'robots');
    return {
      rules: parseRobots(result.body, spec.robotsUrl, spec.dataPath),
      attempts: result.attempts,
    };
  } catch (error) {
    if (error instanceof SourceFetchError && error.code === 'http_4xx' && (error.status === 404 || error.status === 410)) {
      // A missing robots file has no directives to apply.  Other 4xx values
      // are still represented as unavailable by fetchResponse's coarse class.
      return {
        rules: { kind: 'missing', sourceUrl: spec.robotsUrl, checkedPath: spec.dataPath, allowed: true },
        attempts: 1,
      };
    }
    return {
      rules: robotsUnavailable(spec.robotsUrl, spec.dataPath),
      attempts: error instanceof SourceFetchError ? Math.max(1, error.attempts) : 1,
    };
  }
}

function publicError(error: unknown): { code: FetchFailureCode; message: string } {
  if (error instanceof SourceFetchError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof InvalidPayloadError) {
    return { code: 'invalid_payload', message: error.message };
  }
  return { code: 'invalid_payload', message: 'public source returned an unsupported data shape' };
}

function optionsFor(input: SnapshotServiceOptions): ResolvedSnapshotOptions {
  return {
    fetch: input.fetch ?? defaultFetch,
    now: input.now ?? (() => new Date()),
    sleep: input.sleep ?? defaultSleep,
    policy: mergePolicy(input.policy),
    cacheTtlMs: input.cacheTtlMs ?? 5 * 60_000,
    allowedOrigins: new Set((input.sources ?? [...SOURCE_REGISTRY.values()]).map((spec) => new URL(spec.endpoint).origin)),
  };
}

function sourceSnapshot(
  spec: SourceSpec,
  sourceStatus: SourceSnapshot['status'],
  fetchedAt: string,
  sourceUpdatedAt: string | null,
  rows: SourceSnapshot['rows'],
  attempts: number,
  error: string | null,
  now: Date,
): SourceSnapshot {
  const meta = {
    id: spec.source,
    label: spec.label,
    pageUrl: spec.pageUrl,
    endpoint: spec.endpoint,
    status: sourceStatus,
    fetchedAt,
    sourceUpdatedAt,
    maxObservationAgeSeconds: spec.maxObservationAgeSeconds,
    attempts,
    error,
  };
  return refreshSourceStatus({ ...meta, rows }, now.getTime());
}

export class SnapshotService {
  private readonly options: ResolvedSnapshotOptions;
  private readonly sources: ReadonlyMap<SourceId, SourceSpec>;
  private readonly cache = new Map<SourceId, CachedSource>();
  private readonly failures = new Map<SourceId, { until: number; snapshot: SourceSnapshot }>();
  private readonly failureCacheTtlMs: number;
  private inFlight: Promise<HealthIntelligenceSnapshot> | null = null;

  constructor(options: SnapshotServiceOptions = {}) {
    this.options = optionsFor(options);
    this.sources = options.sources ? createSourceRegistry(options.sources) : SOURCE_REGISTRY;
    this.failureCacheTtlMs = options.failureCacheTtlMs ?? 0;
    if (!Number.isInteger(this.failureCacheTtlMs) || this.failureCacheTtlMs < 0 || this.failureCacheTtlMs > 300_000) {
      throw new Error('failureCacheTtlMs is outside the safe range');
    }
    if (!Number.isInteger(this.options.cacheTtlMs) || this.options.cacheTtlMs < 0 || this.options.cacheTtlMs > 60 * 60_000) {
      throw new Error('cacheTtlMs is outside the safe range');
    }
    for (const source of options.initialSnapshot?.sources ?? []) {
      if (source.status === 'error') continue;
      this.cache.set(source.id, {
        sourceUpdatedAt: source.sourceUpdatedAt,
        fetchedAt: source.fetchedAt,
        rows: source.rows,
      });
    }
  }

  async read(force = false): Promise<HealthIntelligenceSnapshot> {
    if (this.inFlight) return this.inFlight;
    const request = this.readSources(force);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }

  private async readSources(force: boolean): Promise<HealthIntelligenceSnapshot> {
    const now = this.options.now();
    const values = await Promise.all([...this.sources.values()].map((spec) => this.readSource(spec, now, force)));
    return {
      schemaVersion: 1,
      generatedAt: this.options.now().toISOString(),
      sources: values,
    };
  }

  private async readSource(spec: SourceSpec, now: Date, force: boolean): Promise<SourceSnapshot> {
    const id = spec.source;
    const cached = this.cache.get(id);
    const failed = this.failures.get(id);
    if (failed && now.getTime() < failed.until) return refreshSourceStatus(failed.snapshot, now.getTime());
    if (!force && cached && now.getTime() - Date.parse(cached.fetchedAt) < this.options.cacheTtlMs) {
      return sourceSnapshot(spec, 'ok', cached.fetchedAt, cached.sourceUpdatedAt, cached.rows, 0, null, now);
    }
    let attempts = 0;
    try {
      const robots = await fetchRobots(spec, this.options);
      attempts += robots.attempts;
      if (!robots.rules.allowed) {
        const code: FetchFailureCode = robots.rules.kind === 'unavailable' ? 'robots_unavailable' : 'robots_denied';
        throw new SourceFetchError(code, code === 'robots_denied'
          ? 'robots policy disallows this public endpoint'
          : 'robots policy could not be verified', false);
      }
      const result = await fetchJson(spec.endpoint, this.options);
      attempts += result.attempts;
      const resultRows = spec.normalize(result.body);
      const normalized = { ...resultRows, rows: normalizedRows(resultRows.rows) };
      const completedAt = this.options.now();
      const fetchedAt = completedAt.toISOString();
      this.failures.delete(id);
      this.cache.set(id, {
        sourceUpdatedAt: normalized.sourceUpdatedAt,
        fetchedAt,
        rows: normalized.rows,
      });
      return sourceSnapshot(spec, 'ok', fetchedAt, normalized.sourceUpdatedAt, normalized.rows, attempts, null, completedAt);
    } catch (error) {
      attempts += error instanceof SourceFetchError ? error.attempts : 0;
      const failure = publicError(error);
      const completedAt = this.options.now();
      const snapshot = cached
        ? sourceSnapshot(spec, 'stale', cached.fetchedAt, cached.sourceUpdatedAt, cached.rows, attempts, failure.message, completedAt)
        : sourceSnapshot(spec, 'error', completedAt.toISOString(), null, [], attempts, failure.message, completedAt);
      this.failures.set(id, { until: completedAt.getTime() + this.failureCacheTtlMs, snapshot });
      return snapshot;
    }
  }
}

export { fetchJson, readBodyWithCap };
