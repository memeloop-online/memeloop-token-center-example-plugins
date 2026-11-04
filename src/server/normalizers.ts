import type {
  AixHanRow,
  CodexRadarRow,
  DeepSweRow,
} from '../shared/types.js';

export interface NormalizedCodexRadar {
  readonly sourceUpdatedAt: string | null;
  readonly rows: CodexRadarRow[];
}

export interface NormalizedDeepSwe {
  readonly sourceUpdatedAt: string | null;
  readonly rows: DeepSweRow[];
}

export interface NormalizedAixHan {
  readonly sourceUpdatedAt: string | null;
  readonly rows: AixHanRow[];
}

export class InvalidPayloadError extends Error {
  readonly code = 'invalid_payload';

  constructor() {
    super('public source returned an unsupported data shape');
    this.name = 'InvalidPayloadError';
  }
}

const MAX_ROWS = 24;
const MAX_TEXT = 160;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new InvalidPayloadError();
  return value;
}

function text(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : Math.min(1_000_000_000, Math.floor(number));
}

function fraction(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  const normalized = number > 1 ? number / 100 : number;
  return normalized >= 0 && normalized <= 1 ? normalized : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function requiredText(value: unknown): string | null {
  const result = text(value);
  return result === '' ? null : result;
}

export function normalizeCodexRadar(payload: unknown): NormalizedCodexRadar {
  const body = record(payload);
  if (!body) throw new InvalidPayloadError();
  const pointValues = requiredArray(body.comprehensive_points);
  const rows: CodexRadarRow[] = [];
  for (const value of pointValues) {
    const point = record(value);
    const model = point ? requiredText(point.model) : null;
    const effort = point ? requiredText(point.effort) : null;
    const iq = point ? finiteNumber(point.iq) : null;
    if (!model || !effort || iq === null || iq < 0 || iq > 200) continue;
    rows.push({
      key: `${model}:${effort}`.slice(0, 180),
      model,
      effort,
      iq,
      softwareIq: point ? finiteNumber(point.software_iq) : null,
      visualIq: point ? finiteNumber(point.visual_iq) : null,
      samples: point ? nonNegativeInteger(point.samples) : null,
    });
  }
  if (pointValues.length > 0 && rows.length === 0) throw new InvalidPayloadError();
  rows.sort((left, right) => right.iq - left.iq || left.key.localeCompare(right.key));
  return {
    // The public page accepts a timestamp map as well as a single timestamp.
    sourceUpdatedAt: record(body.source_updated_at)
      ? Object.values(record(body.source_updated_at)!).map(isoDate)
        .filter((value): value is string => value !== null).sort().at(-1) ?? null
      : isoDate(body.source_updated_at) ?? isoDate(body.generated_at),
    rows: rows.slice(0, MAX_ROWS),
  };
}

export function normalizeDeepSwe(payload: unknown): NormalizedDeepSwe {
  const body = record(payload);
  if (!body) throw new InvalidPayloadError();
  const rowValues = requiredArray(body.rows);
  const rows: DeepSweRow[] = [];
  for (const value of rowValues) {
    const row = record(value);
    const model = row ? requiredText(row.model) : null;
    const effort = row ? requiredText(row.reasoning_effort) ?? 'unspecified' : null;
    const passRate = row ? fraction(row.pass_rate) : null;
    if (!model || !effort || passRate === null) continue;
    const passAt4 = row ? fraction(row.pass_at_4) : null;
    const cost = row ? finiteNumber(row.mean_cost_usd) : null;
    const outputTokens = row ? finiteNumber(row.mean_output_tokens) : null;
    const agentSteps = row ? finiteNumber(row.mean_agent_steps) : null;
    const harness = row ? requiredText(row.harness) : null;
    const config = row ? requiredText(row.config) : null;
    rows.push({
      key: (config ?? [model, effort, harness].filter(Boolean).join(':')).slice(0, 180),
      model,
      effort,
      harness, config,
      provider: row ? requiredText(row.provider) : null,
      costBasis: row ? requiredText(row.cost_basis) : null,
      passRate,
      passAt4,
      averageCostUsd: cost !== null && cost >= 0 && cost <= 1_000_000 ? cost : null,
      outputTokens: outputTokens !== null && outputTokens >= 0 ? outputTokens : null,
      agentSteps: agentSteps !== null && agentSteps >= 0 ? agentSteps : null,
      samples: row ? nonNegativeInteger(row.n_attempted) : null,
    });
  }
  if (rowValues.length > 0 && rows.length === 0) throw new InvalidPayloadError();
  rows.sort((left, right) => right.passRate - left.passRate || left.key.localeCompare(right.key));
  return {
    sourceUpdatedAt: isoDate(body.generated_at),
    rows: rows.slice(0, MAX_ROWS),
  };
}

function aixHanStatus(value: unknown): AixHanRow['status'] {
  const status = text(value).toLowerCase();
  if (status === 'operational' || status === 'degraded' || status === 'error') return status;
  return 'unknown';
}

export function normalizeAixHan(payload: unknown): NormalizedAixHan {
  const body = record(payload);
  if (!body) throw new InvalidPayloadError();
  const timelines = requiredArray(body.providerTimelines);
  const rows: AixHanRow[] = [];
  for (const value of timelines) {
    const timeline = record(value);
    if (!timeline) continue;
    const latest = record(timeline.latest);
    const timelineItems = [latest, ...array(timeline.items).map(record)]
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((left, right) => {
        const leftTime = Date.parse(isoDate(left.checkedAt) ?? '') || 0;
        const rightTime = Date.parse(isoDate(right.checkedAt) ?? '') || 0;
        return rightTime - leftTime;
    });
    const item = timelineItems[0];
    if (!item) continue;
    const name = requiredText(item.name) ?? requiredText(timeline.name);
    const status = requiredText(item.status);
    if (!name || !status) continue;
    const history: Record<string, string | number | null> = {};
    const seen = new Set<string>();
    for (const observation of timelineItems) {
      const at = isoDate(observation.checkedAt);
      if (!at || seen.has(at) || seen.size >= 6) continue;
      const index = seen.size;
      seen.add(at);
      const ms = finiteNumber(observation.latencyMs);
      history[`sample${index}At`] = at;
      history[`sample${index}Status`] = aixHanStatus(observation.status);
      history[`sample${index}LatencyMs`] = ms !== null && ms >= 0 && ms <= 86_400_000 ? ms : null;
    }
    const checkedAt = isoDate(item.checkedAt);
    const latency = finiteNumber(item.latencyMs);
    const pingLatency = finiteNumber(item.pingLatencyMs);
    rows.push({
      key: (requiredText(item.id) ?? name).slice(0, 180),
      name,
      model: requiredText(item.model),
      providerType: requiredText(item.type),
      status: aixHanStatus(status),
      latencyMs: latency !== null && latency >= 0 && latency <= 86_400_000 ? latency : null,
      pingLatencyMs: pingLatency !== null && pingLatency >= 0 && pingLatency <= 86_400_000 ? pingLatency : null,
      checkedAt,
      message: requiredText(item.message),
      ...history,
    });
  }
  if (timelines.length > 0 && rows.length === 0) throw new InvalidPayloadError();
  rows.sort((left, right) => {
    const rank: Record<AixHanRow['status'], number> = { error: 0, degraded: 1, unknown: 2, operational: 3 };
    return rank[left.status] - rank[right.status] || left.key.localeCompare(right.key);
  });
  const newest = rows
    .map((row) => row.checkedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  return { sourceUpdatedAt: newest, rows: rows.slice(0, MAX_ROWS) };
}
