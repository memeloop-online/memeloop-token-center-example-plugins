import type { SourceSnapshot } from './types.js';
import { MAX_CLOCK_SKEW_MS } from './limits.js';

/** Re-evaluate absolute timestamps whenever a stored snapshot is consumed. */
export function refreshSourceStatus(source: SourceSnapshot, now = Date.now()): SourceSnapshot {
  const fetched = Date.parse(source.fetchedAt);
  const observed = source.sourceUpdatedAt === null ? null : Date.parse(source.sourceUpdatedAt);
  const expired = !Number.isFinite(fetched) || (observed !== null && !Number.isFinite(observed))
    || fetched > now + MAX_CLOCK_SKEW_MS || (observed !== null && observed > now + MAX_CLOCK_SKEW_MS)
    || now - fetched > 20 * 60_000
    || (observed !== null && now - observed > source.maxObservationAgeSeconds * 1000);
  return { ...source, status: source.status === 'ok' && expired ? 'stale' : source.status };
}
