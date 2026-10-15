import type { HealthIntelligenceSnapshot } from '../shared/types.js';
import { decodeSnapshot } from './decodeSnapshot.js';
import { readBodyWithCap, type FetchLike } from './fetcher.js';

export const PUBLISHED_SNAPSHOT_URL = 'https://memeloop-online.github.io/memeloop-token-center-example-plugins/api/health-intelligence.json';

export async function fetchPublishedSnapshot(fetcher: FetchLike = fetch): Promise<HealthIntelligenceSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(PUBLISHED_SNAPSHOT_URL, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`published snapshot returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html')) throw new Error('published snapshot returned HTML');
    return decodeSnapshot(JSON.parse(await readBodyWithCap(response, 1_048_576)) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}
