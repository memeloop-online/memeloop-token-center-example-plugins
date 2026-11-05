/**
 * The only data contract crossing the server/browser boundary.  Raw upstream
 * payloads never appear in this type (or in an API response).
 */

export type SourceId = string;
export type SourceStatus = 'ok' | 'stale' | 'error';

export interface SourceMeta {
  id: SourceId;
  label: string;
  pageUrl: string;
  endpoint: string;
  status: SourceStatus;
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  maxObservationAgeSeconds: number;
  attempts: number;
  error: string | null;
}

export interface CodexRadarRow extends SourceRow {
  key: string;
  model: string;
  effort: string;
  iq: number;
  softwareIq: number | null;
  visualIq: number | null;
  samples: number | null;
}

export interface DeepSweRow extends SourceRow {
  key: string;
  model: string;
  effort: string;
  passRate: number;
  passAt4: number | null;
  averageCostUsd: number | null;
  outputTokens: number | null;
  agentSteps: number | null;
  samples: number | null;
}

export type AixHanStatus = 'operational' | 'degraded' | 'error' | 'unknown';

export interface AixHanRow extends SourceRow {
  key: string;
  name: string;
  model: string | null;
  providerType: string | null;
  status: AixHanStatus;
  latencyMs: number | null;
  pingLatencyMs: number | null;
  checkedAt: string | null;
  message: string | null;
}

export interface CodexRadarSnapshot extends SourceMeta {
  id: 'codexradar';
  rows: CodexRadarRow[];
}

export interface DeepSweSnapshot extends SourceMeta {
  id: 'deepswe';
  rows: DeepSweRow[];
}

export interface AixHanSnapshot extends SourceMeta {
  id: 'aixhan';
  rows: AixHanRow[];
}

export interface SourceRow {
  key: string;
  [field: string]: string | number | boolean | null;
}

export interface SourceSnapshot extends SourceMeta {
  rows: SourceRow[];
}

export interface HealthIntelligenceSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sources: SourceSnapshot[];
}

export function isSourceId(value: string): value is SourceId {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value);
}
