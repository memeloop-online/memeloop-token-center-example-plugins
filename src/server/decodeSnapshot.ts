import type {
  AixHanRow,
  CodexRadarRow,
  DeepSweRow,
  HealthIntelligenceSnapshot,
  SourceId,
  SourceSnapshot,
} from '../shared/types.js';
import { isSourceId, type SourceRow } from '../shared/types.js';
import { MAX_SOURCES, MAX_ROWS, MAX_CLOCK_SKEW_MS } from '../shared/limits.js';
import { scalarRow } from '../shared/rows.js';
import { refreshSourceStatus } from '../shared/freshness.js';

export class SnapshotDecodeError extends Error {
  constructor() {
    super('health intelligence response does not match schema version 1');
    this.name = 'SnapshotDecodeError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = 160): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableText(value: unknown, max = 160): value is string | null {
  return value === null || text(value, max);
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return number(value) && value >= min && value <= max;
}

function nullableNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number | null {
  return value === null || boundedNumber(value, min, max);
}

function date(value: unknown): value is string {
  return text(value, 80) && !Number.isNaN(Date.parse(value));
}

function sourceMeta(value: Record<string, unknown>, id: SourceId): boolean {
  return value.id === id
    && text(value.label, 120)
    && publicUrl(value.pageUrl)
    && publicUrl(value.endpoint)
    && (value.status === 'ok' || value.status === 'stale' || value.status === 'error')
    && date(value.fetchedAt)
    && (value.sourceUpdatedAt === null || date(value.sourceUpdatedAt))
    && boundedNumber(value.maxObservationAgeSeconds, 1, Number.MAX_SAFE_INTEGER)
    && number(value.attempts) && Number.isInteger(value.attempts) && boundedNumber(value.attempts, 0, 12)
    && nullableText(value.error, 256);
}

function publicUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === '' && !/[\u0000-\u0020\u007f\\]/u.test(value);
  } catch { return false; }
}

function codexRadarRow(value: unknown): CodexRadarRow | null {
  const row = record(value);
  if (!row || !text(row.key, 180) || !text(row.model) || !text(row.effort)
    || !boundedNumber(row.iq, 0, 200)
    || !nullableNumber(row.softwareIq, -1000, 1000)
    || !nullableNumber(row.visualIq, -1000, 1000)
    || (row.samples !== null && (!number(row.samples) || !Number.isInteger(row.samples) || !boundedNumber(row.samples, 0, 1_000_000_000)))) return null;
  return row as unknown as CodexRadarRow;
}

function deepSweRow(value: unknown): DeepSweRow | null {
  const row = record(value);
  if (!row || !text(row.key, 180) || !text(row.model) || !text(row.effort)
    || !boundedNumber(row.passRate, 0, 1)
    || !nullableNumber(row.passAt4, 0, 1)
    || !nullableNumber(row.averageCostUsd, 0, 1_000_000)
    || !nullableNumber(row.outputTokens)
    || !nullableNumber(row.agentSteps)
    || (row.samples !== null && (!number(row.samples) || !Number.isInteger(row.samples) || !boundedNumber(row.samples, 0, 1_000_000_000)))) return null;
  return row as unknown as DeepSweRow;
}

function aixHanRow(value: unknown): AixHanRow | null {
  const row = record(value);
  if (!row || !text(row.key, 180) || !text(row.name)
    || !nullableText(row.model) || !nullableText(row.providerType)
    || !['operational', 'degraded', 'error', 'unknown'].includes(String(row.status))
    || !nullableNumber(row.latencyMs, 0, 86_400_000)
    || !nullableNumber(row.pingLatencyMs, 0, 86_400_000)
    || !(row.checkedAt === null || date(row.checkedAt))
    || !nullableText(row.message)) return null;
  return row as unknown as AixHanRow;
}

const rowDecoders: Record<string, (value: unknown) => SourceRow | null> = {
  codexradar: codexRadarRow, deepswe: deepSweRow, aixhan: aixHanRow,
};

function source(value: unknown): SourceSnapshot | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.id !== 'string' || !isSourceId(candidate.id)
    || !sourceMeta(candidate, candidate.id) || !Array.isArray(candidate.rows) || candidate.rows.length > MAX_ROWS) return null;
  const id = candidate.id;
  const decode = Object.hasOwn(rowDecoders, id) ? rowDecoders[id]! : scalarRow;
  const rows = candidate.rows.map((row) => scalarRow(row) && decode(row));
  if (rows.some((row) => row === null)) return null;
  return { ...candidate, id, rows } as unknown as SourceSnapshot;
}

export function decodeSnapshot(value: unknown, now = Date.now()): HealthIntelligenceSnapshot {
  const root = record(value);
  const rawSources = root?.sources;
  if (!root || root.schemaVersion !== 1 || !date(root.generatedAt)
    || Date.parse(root.generatedAt) > now + MAX_CLOCK_SKEW_MS
    || !Array.isArray(rawSources) || rawSources.length > MAX_SOURCES) throw new SnapshotDecodeError();
  const sources = rawSources.map(source);
  if (sources.some((entry) => entry === null)) throw new SnapshotDecodeError();
  if (new Set(sources.map((entry) => entry!.id)).size !== sources.length) throw new SnapshotDecodeError();
  return {
    schemaVersion: 1,
    generatedAt: root.generatedAt,
    sources: sources.map((entry) => refreshSourceStatus(entry!, now)),
  };
}
