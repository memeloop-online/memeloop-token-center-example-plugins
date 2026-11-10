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
  it('keeps successful sources fresh when another source fails in a partial network result', async () => {
    const module = await import(url);
    const now = Date.now();
    const data = { sources: [{ id: 'deepswe', status: 'ok', rows: [] }, { id: 'aixhan', status: 'error', rows: [] }] };
    const provenance = { plugin_id: 'mtc-health-intelligence', endpoint_id: 'health-intelligence',
      source: 'network', fetched_at: now, freshness: 'fresh' };
    expect(module.runtimeSnapshot({ data, partial: true, provenance }, now)).toBe(data);
    expect(module.runtimeSnapshot({ data, partial: true, provenance: { ...provenance, freshness: undefined } }, now)).toBe(data);
    expect(module.runtimeSnapshot({ data, partial: true, provenance: { ...provenance, freshness: 'stale' } }, now).sources[0].status).toBe('stale');
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

  it.each([
    ['zh-CN', ['正常', '降级', '异常', '未知'], '未知'],
    ['en-US', ['Operational', 'Degraded', 'Error', 'Unknown'], 'Unknown'],
  ])('renders localized model statuses and safe unknown values for %s', async (locale, labels, unknownLabel) => {
    const module = await import(url);
    const statuses = ['operational', 'degraded', 'error', 'unknown',
      'pending', 'ok', '__proto__', 'constructor', '', null, undefined, 42, false, {}];
    const snapshot = { sources: [{
      id: 'aixhan', label: 'CDK 模型健康', status: 'ok',
      fetchedAt: new Date().toISOString(), rows: statuses.map((status) => ({ status })),
    }, {
      id: 'deepswe', label: 'DeepSWE 工程能力', status: 'ok',
      fetchedAt: new Date().toISOString(), rows: [{ model: 'unknown', samples: 7, message: null }],
    }] };
    const tableCell = 'dd';
    const cells: unknown[] = [];
    let stateIndex = 0;
    const componentPackage = module.activateOperatorUi({
      React: {
        createElement: (type: unknown, _props: unknown, ...children: unknown[]) => {
          if (type === tableCell) cells.push(...children);
          return { type, children };
        },
        useEffect: () => {},
        useMemo: (factory: () => unknown) => factory(),
        useState: (initial: unknown) => {
          const value = stateIndex++ === 0 ? snapshot
            : initial === true ? false : typeof initial === 'function' ? initial() : initial;
          return [value, () => {}];
        },
      },
      Fluent: {
        makeStyles: () => () => ({}), mergeClasses: () => '', tokens: {}, TableCell: tableCell,
      },
      defineOperatorUiPackage: (value: unknown) => value,
    });
    componentPackage.components['health-intelligence']({ locale, api: {} });
    expect(cells).toEqual([
      ...labels, ...statuses.slice(4).map(() => unknownLabel),
      'unknown', '7', '—',
    ]);
  });

  it('separates old source publications, expired collection caches and unknown observation dates', async () => {
    const module = await import(url);
    const now = Date.parse('2026-11-04T20:30:00Z');
    const base = { status: 'ok', fetchedAt: new Date(now).toISOString(), sourceUpdatedAt: null, maxObservationAgeSeconds: 2592000 };
    expect(module.freshnessReason(base, now)).toBe('sourceUnknown');
    expect(module.freshnessReason({ ...base, sourceUpdatedAt: '2026-09-22T06:27:15.860Z' }, now)).toBe('sourceOld');
    expect(module.freshnessReason({ ...base, fetchedAt: '2026-11-04T19:00:00Z', sourceUpdatedAt: '2026-09-22T06:27:15.860Z' }, now)).toBe('stale');
    expect(module.freshnessReason({ ...base, sourceUpdatedAt: '2026-11-04T20:29:00Z' }, now)).toBe('ok');
  });

  it('charts source values in their own units and leaves missing observations as gaps', async () => {
    const module = await import(url);
    const option = module.comparisonOption({ rows: [{ model: '<img>', effort: 'high', passRate: 0.741 }, { model: 'missing', passRate: null }] }, 'passRate', 'Pass rate', true);
    expect(option.series[0].data).toEqual([74.1]);
    expect(option.tooltip.renderMode).toBe('richText');
    expect(option.xAxis.splitNumber).toBe(2);
    expect(option.xAxis.axisLabel.hideOverlap).toBe(true);
    const cost = module.comparisonOption({ rows: [{ model: 'm', averageCostUsd: 4.429117203539823 }] }, 'averageCostUsd', 'USD');
    expect(cost.series[0].data[0]).toBe(4.429117203539823);
    expect(cost.series[0].label.formatter({ value: 4.429117203539823 })).toBe('4.43');
    const latency = module.comparisonOption({ rows: [] }, 'latencyMs', 'ms');
    expect(latency.xAxis.axisLabel.formatter(2000)).toBe('2k');
    const history = module.historyOption({ sample0At: '2026-11-04T20:29:00Z', sample0LatencyMs: null,
      sample1At: '2026-11-04T20:24:00Z', sample1LatencyMs: 1234 }, 'Response start');
    expect(history.series[0].data).toEqual([[Date.parse('2026-11-04T20:24:00Z'), 1234], [Date.parse('2026-11-04T20:29:00Z'), null]]);
    expect(history.series[0].connectNulls).toBe(false);
  });

  it('wraps complete source labels and formats tooltip values without changing chart data', async () => {
    const module = await import(url);
    const row = { model: 'a-model-with-a-long-complete-name', effort: 'xhigh',
      harness: 'mini-swe-agent', config: 'long-configuration-without-spaces', passRate: 0.7411504424778761 };
    const chart = module.comparisonOption({ rows: [row] }, 'passRate', 'Pass rate', true);
    const tooltip = chart.tooltip.formatter([{ dataIndex: 0, value: chart.series[0].data[0] }]);
    expect(tooltip.replaceAll('\n', '')).toContain(row.model);
    expect(tooltip.replaceAll('\n', '')).toContain(row.config);
    expect(tooltip).toContain('74.12%');
    expect(tooltip.split('\n').every(line => Array.from(line).length <= 18)).toBe(true);
    expect(module.metricTooltip('ms').formatter({ seriesName: 'Latency', value: 0 })).toContain('0 ms');
    expect(module.metricTooltip('USD').formatter({ value: 0.0007 })).toContain('0.0007 USD');
    const history = module.metricTooltip('ms', item => item.seriesName, true).formatter([
      { seriesName: 'first', value: [0, 1234.6] }, { seriesName: 'missing', value: [0, null] },
    ]);
    expect(history).toContain('1,235 ms');
    expect(history).toContain('missing');
    expect(history).toContain('—');
    expect(history.replaceAll('\n', '')).toContain('1970-01-01T00:00:00.000Z');
    const literal = module.metricTooltip('IQ').formatter({ seriesName: '{style|text}', value: 100 });
    expect(literal).not.toMatch(/\{([a-zA-Z0-9_]+)\|([^}]*)\}/g);
    expect(literal.replaceAll('\u200b', '')).toContain('{style|text}');
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
