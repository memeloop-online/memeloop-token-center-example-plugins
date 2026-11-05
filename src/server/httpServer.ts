import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SnapshotService } from './fetcher.js';
import { ADVICE_PATH } from './concurrencyAdvice.js';
import type { ConcurrencyAdviceService } from './concurrencyService.js';

const API_PATH = '/api/health-intelligence';

function json(response: ServerResponse, status: number, value: unknown, privateData = false): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', status === 200 && !privateData
    ? 'public, max-age=300, stale-if-error=3600'
    : 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.end(body);
}

function pathname(request: IncomingMessage): { path: string; refresh: boolean } | null {
  try {
    const url = new URL(request.url ?? '/', 'http://token-center.local');
    if (url.pathname !== API_PATH) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== 'refresh')) return null;
    return { path: url.pathname, refresh: url.searchParams.get('refresh') === '1' };
  } catch {
    return null;
  }
}

export interface HealthIntelligenceServerOptions {
  readonly snapshotService: SnapshotService;
  readonly concurrencyService?: ConcurrencyAdviceService;
}

/**
 * Host-facing HTTP adapter. Private advice requires a separately scoped token. It never
 * accepts a caller-provided URL, headers, or credentials.
 */
export function createHealthIntelligenceServer(options: HealthIntelligenceServerOptions): Server {
  return createServer(async (request, response) => {
    const advice = options.concurrencyService;
    if (request.url?.split('?', 1)[0] === ADVICE_PATH) {
      if (request.method !== 'GET' || request.url !== ADVICE_PATH || !advice) {
        json(response, 404, { error: 'not_found' });
      } else if (!advice.authorized(request)) {
        response.setHeader('www-authenticate', 'Bearer');
        json(response, 401, { error: 'unauthorized' });
      } else {
        json(response, 200, advice.read(), true);
      }
      return;
    }
    const route = pathname(request);
    if (request.method !== 'GET' || !route) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    try {
      const snapshot = await options.snapshotService.read(route.refresh);
      const ok = snapshot.sources.some((source) => source.status !== 'error');
      json(response, ok ? 200 : 503, snapshot);
    } catch {
      json(response, 503, { error: 'snapshot_unavailable' });
    }
  });
}

export { API_PATH };
