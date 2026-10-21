import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HEALTH_INTELLIGENCE_ENDPOINT_ID,
  HEALTH_INTELLIGENCE_SERVICE_URL,
  ManifestContractError,
  readHealthIntelligenceManifest,
  readHealthIntelligenceTab,
} from '../src/manifestAdapter.js';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../plugin.json', import.meta.url)), 'utf8')) as unknown;

describe('core contribution adapter', () => {
  it('adapts the product v1 service_data and Monitoring tab contract', () => {
    const result = readHealthIntelligenceManifest(manifest);
    expect(result.tab).toEqual({
      id: 'health-and-intelligence',
      slot: 'operator.sidebar.tab',
      category: { id: 'monitoring' },
      route: 'health-intelligence',
      label: '模型健康与能力',
      icon: 'heart',
      renderer: 'component_v1',
      moduleEntry: 'ui/health-intelligence.mjs',
      componentId: 'health-intelligence',
      dataEndpoint: HEALTH_INTELLIGENCE_ENDPOINT_ID,
    });
    expect(result.serviceData).toMatchObject({
      id: HEALTH_INTELLIGENCE_ENDPOINT_ID,
      componentAdapter: { api_version: 'component-v1', collector: 'health-three-source-v1', normalizer: 'health-snapshot-v1' },
      requiredScope: 'metrics:read',
      cacheTtlSeconds: 300,
      timeoutMillis: 30000,
      maxBodyBytes: 1048576,
    });
    expect(result.serviceData.responseSchema).toMatchObject({ type: 'object' });
    expect(result.serviceData.fallback).toMatchObject({ schemaVersion: 1 });
    expect(Array.isArray(result.serviceData.fallback.sources) ? result.serviceData.fallback.sources : []).toHaveLength(3);
  });

  it('rejects the removed executable/remote UI contract', () => {
    const unsafe = structuredClone(manifest) as Record<string, unknown>;
    const contributions = unsafe.contributions as Record<string, unknown>;
    contributions.ui = { tabs: [] };
    expect(() => readHealthIntelligenceTab(unsafe)).toThrow(ManifestContractError);
  });
});
