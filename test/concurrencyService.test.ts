import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ConcurrencyAdviceService } from '../src/server/concurrencyService.js';
import { createHealthIntelligenceServer } from '../src/server/httpServer.js';
import { SnapshotService } from '../src/server/fetcher.js';
import { fixtureFetch, fixedNow } from './testUtils.js';
import { ADVICE_PATH } from '../src/server/concurrencyAdvice.js';

const serviceToken = 'fixture-service-token-not-a-secret';
const readToken = 'fixture-advice-token-not-a-secret';
const now = 900_000;
function coreSnapshot() {
  return { contract_version: 'upstream_concurrency_v1', observed_at: now, stale: false, sample_interval_ms: 5_000,
    retention_ms: 900_000, samples_truncated: false,
    metadata_gaps: { missing_account_samples: 0, missing_egress_samples: 0, invalid_egress_samples: 0 },
    samples: [{ must_not_escape: 'private-endpoint-and-request-identifiers' }],
    series: [{ tenant_external_id: 'tenant-a', dimension: 'upstream_account', identity: 'account-a',
      measurement_basis: 'request_owner_live_lease', current: 2, sampled_peak: 2, sample_ids: ['private-request-id'],
      points: [{ observed_at: now - 5_000, value: 1, truncated: false }, { observed_at: now, value: 2, truncated: false }] }] };
}
function service(fetch: typeof globalThis.fetch, clock: () => number = () => now) {
  return new ConcurrencyAdviceService({ coreOrigin: 'https://control.example', tenantExternalId: 'tenant-a',
    serviceToken, readToken, fetch, now: clock });
}

describe('background advice companion', () => {
  it('uses only fixed tenant-scoped read-only core routes and definitive pagination', async () => {
    const calls: URL[] = [];
    const fetchCore: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      expect(url.origin).toBe('https://control.example');
      expect(url.searchParams.get('tenant_external_id')).toBe('tenant-a');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${serviceToken}` });
      if (url.pathname.endsWith('upstream-concurrency')) return Response.json(coreSnapshot());
      expect(url.pathname).toBe('/internal/v1/requests');
      expect(url.searchParams.get('paged')).toBe('true');
      return Response.json({ requests: [], next_cursor: calls.length === 2
        ? { before_created_at: now - 1, before_id: '00000000-0000-0000-0000-000000000001' } : null });
    };
    const collector = service(fetchCore);
    await Promise.all([collector.refresh(), collector.refresh()]);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.searchParams.get('before_created_at')).toBe(String(now - 1));
    const snapshot = collector.read();
    expect(snapshot.collection.state).toBe('ok');
    expect(snapshot.series[0]!.current).toBe(2);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain(serviceToken);
    expect(encoded).not.toContain('private-request-id');
    expect(encoded).not.toContain('private-endpoint');
    expect(encoded).not.toContain('sample_ids');
    await collector.stop();
  });

  it('returns explicit initial progress, expires current by wall time and redacts collection errors', async () => {
    let time = now;
    let fail = false;
    const collector = service(async (input) => {
      if (fail) throw new Error(`do-not-expose-${serviceToken}`);
      return Response.json(String(input).includes('upstream-concurrency') ? coreSnapshot() : { requests: [], next_cursor: null });
    }, () => time);
    expect(collector.read()).toMatchObject({ stale: true, collection: { state: 'awaiting_first_sample' },
      observation: { metadata_gaps: null }, series: [] });
    await collector.refresh();
    time += 10_001;
    expect(collector.read()).toMatchObject({ stale: true, series: [{ current: null, recommendation: null }] });
    fail = true;
    await collector.refresh();
    const snapshot = collector.read();
    expect(snapshot.collection).toMatchObject({ state: 'collection_failed', last_error_at: time });
    expect(JSON.stringify(snapshot)).not.toContain(serviceToken);
  });

  it('makes a request-page budget visible and suppresses evidence when source pagination is incomplete', async () => {
    const collector = new ConcurrencyAdviceService({ coreOrigin: 'https://control.example', tenantExternalId: 'tenant-a',
      serviceToken, readToken, now: () => now, maxRequestPages: 1,
      fetch: async (input) => Response.json(String(input).includes('upstream-concurrency') ? coreSnapshot()
        : { requests: [], next_cursor: { before_created_at: now - 1, before_id: '00000000-0000-0000-0000-000000000001' } }) });
    await collector.refresh();
    expect(collector.read().observation.requests_truncated).toBe(true);
  });

  it('rejects unsafe configuration and malformed or oversized core responses', async () => {
    expect(() => new ConcurrencyAdviceService({ coreOrigin: 'http://remote.example', tenantExternalId: 't', serviceToken, readToken })).toThrow();
    expect(() => new ConcurrencyAdviceService({ coreOrigin: 'https://control.example/path', tenantExternalId: 't', serviceToken, readToken })).toThrow();
    expect(() => new ConcurrencyAdviceService({ coreOrigin: 'https://control.example', tenantExternalId: 't', serviceToken, readToken: serviceToken })).toThrow();
    for (const body of [Response.json({ ...coreSnapshot(), series: [{ ...coreSnapshot().series[0], tenant_external_id: 'another' }] }),
      new Response('x'.repeat(8_388_609))]) {
      const collector = service(async () => body);
      await collector.refresh();
      expect(collector.read().collection.state).toBe('collection_failed');
      expect(collector.read().series).toHaveLength(0);
    }
  });

  it('protects private GET with an independent credential and no-store without exposing refresh or tenant selectors', async () => {
    const collector = service(async (input) => Response.json(String(input).includes('upstream-concurrency')
      ? coreSnapshot() : { requests: [], next_cursor: null }));
    await collector.refresh();
    const setup = fixtureFetch();
    const snapshotService = new SnapshotService({ fetch: setup.fetch, now: fixedNow, sleep: async () => undefined });
    const server = createHealthIntelligenceServer({ snapshotService, concurrencyService: collector });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const url = `http://127.0.0.1:${address.port}${ADVICE_PATH}`;
    try {
      expect(await fetch(url)).toMatchObject({ status: 401 });
      expect(await fetch(url, { headers: { authorization: `Bearer ${serviceToken}` } })).toMatchObject({ status: 401 });
      const response = await fetch(url, { headers: { authorization: `Bearer ${readToken}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ tenant_external_id: 'tenant-a', application_mode: 'manual_only' });
      expect(await fetch(`${url}?tenant_external_id=other`, { headers: { authorization: `Bearer ${readToken}` } })).toMatchObject({ status: 404 });
      expect(await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${readToken}` } })).toMatchObject({ status: 404 });
    } finally {
      server.close();
      await once(server, 'close');
      await collector.stop();
    }
  });
});

describe('background evidence integrity', () => {
  it('retains a verified proxy binding after its example request completes', async () => {
    let complete = false;
    const collector = service(async (input) => {
      if (!String(input).includes('upstream-concurrency')) return Response.json({ requests: [], next_cursor: null });
      const raw = coreSnapshot();
      return Response.json({ ...raw, series: [{ ...raw.series[0], dimension: 'network_proxy', identity: 'proxy-identity',
        measurement_basis: 'live_owner_with_unfinished_egress_attempt', current: complete ? 0 : 2,
        sample_ids: complete ? [] : ['binding-example'] }], samples: complete ? [] : [{ sample_id: 'binding-example',
        tenant_external_id: 'tenant-a', source: 'request_owner', lease_state: 'live', egress_state: 'unfinished_attempt',
        selected_egress: { kind: 'proxy', scheme: 'http', host: 'example.invalid', port: 8080 } }] });
    });
    await collector.refresh();
    complete = true;
    await collector.refresh();
    expect(collector.read().series[0]).toMatchObject({ identity: 'proxy-identity', current: 0 });
    expect(JSON.stringify(collector.read())).not.toContain('proxyEndpointKey');
  });

  it('reports rejected terminal outcomes rather than silently removing them from success coverage', async () => {
    const collector = service(async (input) => Response.json(String(input).includes('upstream-concurrency') ? coreSnapshot()
      : { requests: [{ request_id: 'unattributed', lifecycle_state: 'failed', upstream_account_id: null }], next_cursor: null }));
    await collector.refresh();
    const snapshot = collector.read();
    expect(snapshot.collection).toMatchObject({ request_records_seen: 1, terminal_outcomes_accepted: 0, terminal_outcomes_rejected: 1 });
    expect(snapshot.series[0]!.sampling.blockers).toContain('unattributed_or_invalid_terminal_outcomes');
    expect(snapshot.series[0]!.recommendation).toBeNull();
  });

  it('rejects repeated cursors instead of claiming complete history', async () => {
    const collector = service(async (input) => Response.json(String(input).includes('upstream-concurrency') ? coreSnapshot()
      : { requests: [], next_cursor: { before_created_at: 10, before_id: '00000000-0000-0000-0000-000000000001' } }));
    await collector.refresh();
    expect(collector.read().collection.state).toBe('collection_failed');
  });
});
