import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_SOURCES, MAX_ROWS, MAX_CLOCK_SKEW_MS } from '../src/shared/limits.js';

const url = new URL('../ui/health-intelligence.mjs', import.meta.url).href;
const schema = JSON.parse(readFileSync(new URL('../schemas-health-intelligence.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));

describe('signed operator UI module', () => {
  it('keeps host failure-cache freshness and endpoint identity in the presentation contract', async () => {
    const module = await import(url);
    const data = { sources: [{ id: 'radar', status: 'ok', rows: [] }] };
    const provenance = { plugin_id: 'mtc-health-intelligence', endpoint_id: 'health-intelligence', freshness: 'stale' };
    expect(module.runtimeSnapshot({ data, partial: true, provenance }).sources[0].status).toBe('stale');
    expect(data.sources[0]?.status).toBe('ok');
    expect(module.runtimeSnapshot({ data, partial: true, provenance: { ...provenance, freshness: 'unavailable' } }).sources[0].status).toBe('error');
    expect(() => module.runtimeSnapshot({ data, provenance: { ...provenance, plugin_id: 'other' } })).toThrow();
    expect(() => module.runtimeSnapshot({ data, provenance: { ...provenance, endpoint_id: 'other' } })).toThrow();
    expect(module.runtimeSnapshot({ data, partial: false, provenance }).sources[0].status).toBe('stale');
    expect(module.runtimeSnapshot({ data, partial: false, provenance: { ...provenance, freshness: 'unavailable' } }).sources[0].status).toBe('error');
  });
  it('renders network and cache responses from the pinned host without a freshness field', async () => {
    const module = await import(url);
    const now = Date.parse('2026-09-19T00:00:00Z');
    const data = { schemaVersion: 1, generatedAt: new Date(now).toISOString(), sources: [{
      ...manifest.contributions.service_data[0].fallback.sources[0],
      status: 'ok', fetchedAt: new Date(now).toISOString(), sourceUpdatedAt: null,
      rows: [{ key: 'model:medium', model: 'Model', effort: 'medium', iq: 100 }],
    }] };
    for (const source of ['network', 'cache']) {
      const response = { data, partial: false, provenance: {
        plugin_id: 'mtc-health-intelligence', endpoint_id: 'health-intelligence',
        origin: 'https://memeloop-online.github.io', fetched_at: now - 60_000, source,
      } };
      expect(module.runtimeSnapshot(response, now)).toBe(data);
      expect(module.runtimeSnapshot({ ...response, provenance: { ...response.provenance,
        fetched_at: now - 21 * 60_000 } }, now).sources[0].status).toBe('stale');
      expect(module.runtimeSnapshot({ ...response, provenance: { ...response.provenance,
        freshness: 'stale' } }, now).sources[0].status).toBe('stale');
    }
  });
  it('preserves records and collection time in the pinned host partial stale-cache response', async () => {
    const module = await import(url);
    const now = Date.parse('2026-09-19T00:00:00Z');
    const data = { schemaVersion: 1, generatedAt: new Date(now).toISOString(), sources: [{
      ...manifest.contributions.service_data[0].fallback.sources[0],
      status: 'ok', fetchedAt: new Date(now - 60_000).toISOString(), sourceUpdatedAt: null,
      rows: [{ key: 'model:medium', model: 'Model', effort: 'medium', iq: 100 }],
    }] };
    const response = { data, partial: true, provenance: {
      plugin_id: 'mtc-health-intelligence', endpoint_id: 'health-intelligence',
      origin: 'https://memeloop-online.github.io', fetched_at: now - 60_000, source: 'stale_cache',
    } };
    const result = module.runtimeSnapshot(response, now);
    expect(result.sources[0].status).toBe('stale');
    expect(result.sources[0].rows).toEqual(data.sources[0]?.rows);
    expect(result.sources[0].fetchedAt).toBe(data.sources[0]?.fetchedAt);
    expect(data.sources[0]?.status).toBe('ok');
    expect(module.runtimeSnapshot({ ...response, partial: false }, now).sources[0].status).toBe('stale');
    expect(module.runtimeSnapshot({ ...response, provenance: { ...response.provenance,
      source: 'cache' } }, now).sources[0].status).toBe('stale');
  });
  it('renders the pinned host fallback response using the declared manifest fallback', async () => {
    const module = await import(url);
    const now = Date.parse('2026-09-19T00:00:00Z');
    const response = { data: manifest.contributions.service_data[0].fallback, partial: true, provenance: {
      plugin_id: 'mtc-health-intelligence', endpoint_id: 'health-intelligence',
      origin: 'https://memeloop-online.github.io', fetched_at: now, source: 'fallback',
    } };
    const result = module.runtimeSnapshot(response, now);
    expect(result.generatedAt).toBeNull();
    expect(result.sources.every((source: { fetchedAt: unknown; sourceUpdatedAt: unknown }) => source.fetchedAt === null && source.sourceUpdatedAt === null)).toBe(true);
    expect(response.data.generatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(result.sources.map((source: { id: string }) => source.id)).toEqual(['codexradar', 'deepswe', 'aixhan']);
    expect(result.sources.every((source: { status: string; rows: unknown[] }) => source.status === 'error' && source.rows.length === 0)).toBe(true);
  });
  it('activates using host React and Fluent and exposes the manifest component', async () => {
    const module = await import(url);
    const componentPackage = module.activateOperatorUi({
      React: {}, Fluent: { makeStyles: () => () => ({}), tokens: {} },
      defineOperatorUiPackage: (value: unknown) => value,
    });
    expect(componentPackage.pluginId).toBe('mtc-health-intelligence');
    expect(componentPackage.compatiblePluginVersions).toContain('1.1.0');
    expect(typeof componentPackage.components['health-intelligence']).toBe('function');
  });

  it('accepts source HTTPS links and rejects executable or credential-bearing URLs', async () => {
    const module = await import(url);
    const pattern = new RegExp(schema.$defs.source.properties.pageUrl.pattern);
    for (const value of ['https://codexradar.com/', 'https://cdk.aixhan.com/model-health']) {
      expect(module.safeSourceHref(value)).toBe(value);
      expect(pattern.test(value)).toBe(true);
    }
    for (const value of [
      'javascript:alert(1)', 'data:text/html,test', '//host.test/path', 'http://host.test/',
      'https://user:secret@host.test/', 'https://host.test/?tracking=yes', 'https://host.test/#fragment',
      'https://host.test/\\evil', 'https://host.test/\npath',
    ]) {
      expect(module.safeSourceHref(value)).toBeNull();
      expect(pattern.test(value)).toBe(false);
    }
  });

  it('shares source, row, and clock-skew limits with the collector contract', async () => {
    const module = await import(url);
    expect(module.MAX_SOURCES).toBe(MAX_SOURCES);
    expect(schema.properties.sources.maxItems).toBe(MAX_SOURCES);
    expect(module.MAX_ROWS).toBe(MAX_ROWS);
    expect(module.MAX_CLOCK_SKEW_MS).toBe(MAX_CLOCK_SKEW_MS);
    expect(module.snapshotSources({ sources: Array(MAX_SOURCES).fill({}) })).toHaveLength(MAX_SOURCES);
    expect(() => module.snapshotSources({ sources: Array(MAX_SOURCES + 1).fill({}) })).toThrow();
    const now = Date.parse('2026-09-19T00:00:00Z');
    expect(module.isRuntimeStale({ fetchedAt: new Date(now + MAX_CLOCK_SKEW_MS + 1).toISOString(),
      sourceUpdatedAt: null, maxObservationAgeSeconds: 60 }, now)).toBe(true);
    expect(module.isRuntimeStale({ fetchedAt: new Date(now).toISOString(),
      sourceUpdatedAt: new Date(now + MAX_CLOCK_SKEW_MS + 1).toISOString(), maxObservationAgeSeconds: 60 }, now)).toBe(true);
  });
});
