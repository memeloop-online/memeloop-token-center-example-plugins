import type { SourceId, SourceRow } from '../shared/types.js';
import { isSourceId } from '../shared/types.js';
import { MAX_SOURCES } from '../shared/limits.js';
import { normalizeCodexRadar, normalizeDeepSwe, normalizeAixHan } from './normalizers.js';
import {
  assertFixedEndpoint,
  type FixedEndpoint,
} from './security.js';

export interface SourceSpec extends FixedEndpoint {
  readonly label: string;
  readonly dataPath: string;
  readonly normalize: (payload: unknown) => { sourceUpdatedAt: string | null; rows: SourceRow[] };
  /** Source publication/check age only; independent of the 20-minute collection cache limit. */
  readonly maxObservationAgeSeconds: number;
}

const specs: Record<SourceId, SourceSpec> = {
  codexradar: {
    source: 'codexradar',
    normalize: normalizeCodexRadar,
    maxObservationAgeSeconds: 7 * 86400,
    label: 'Codex Radar 模型能力',
    pageUrl: 'https://codexradar.com/',
    endpoint: 'https://codexradar.com/api/radar-insights',
    robotsUrl: 'https://codexradar.com/robots.txt',
    dataPath: '/api/radar-insights',
  },
  deepswe: {
    source: 'deepswe',
    normalize: normalizeDeepSwe,
    maxObservationAgeSeconds: 30 * 86400,
    label: 'DeepSWE 工程能力',
    pageUrl: 'https://deepswe.datacurve.ai/',
    endpoint: 'https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json',
    robotsUrl: 'https://deepswe.datacurve.ai/robots.txt',
    dataPath: '/artifacts/v1.1/leaderboard-live.json',
  },
  aixhan: {
    source: 'aixhan',
    normalize: normalizeAixHan,
    maxObservationAgeSeconds: 20 * 60,
    label: 'CDK 模型健康',
    pageUrl: 'https://cdk.aixhan.com/model-health',
    endpoint: 'https://cdk.aixhan.com/api/public/check-cx/dashboard',
    robotsUrl: 'https://cdk.aixhan.com/robots.txt',
    dataPath: '/api/public/check-cx/dashboard',
  },
};

export function createSourceRegistry(entries: readonly SourceSpec[]): ReadonlyMap<SourceId, SourceSpec> {
  if (entries.length > MAX_SOURCES) throw new Error(`source registry supports up to ${MAX_SOURCES} entries`);
  const registry = new Map<SourceId, SourceSpec>();
  for (const spec of entries) {
    const allowed = new Set([new URL(spec.pageUrl).origin]);
    const parsed = assertFixedEndpoint(spec, allowed);
    if (!isSourceId(spec.source) || registry.has(spec.source)
      || parsed.pathname !== spec.dataPath || !Number.isInteger(spec.maxObservationAgeSeconds)
      || spec.maxObservationAgeSeconds <= 0) throw new Error(`invalid source definition: ${spec.source}`);
    registry.set(spec.source, Object.freeze({ ...spec }));
  }
  return registry;
}

export const SOURCE_SPECS: Readonly<Record<SourceId, SourceSpec>> = Object.freeze(specs);
export const SOURCE_REGISTRY = createSourceRegistry(Object.values(SOURCE_SPECS));

export function sourceSpec(id: SourceId): SourceSpec {
  const spec = SOURCE_REGISTRY.get(id);
  if (!spec) throw new Error(`unknown source: ${id}`);
  return spec;
}
