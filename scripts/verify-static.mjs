import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));
const manifest = json('plugin.json');
const reviewedSchema = json('schemas-health-intelligence.json');
const installerTrust = json('release/installer-trust.json');

assert.equal(manifest.id, 'mtc-health-intelligence');
assert.equal(manifest.version, '1.2.1');
assert.equal(json('package.json').version, manifest.version);
assert.equal(json('package-lock.json').version, manifest.version);
assert.equal(json('package-lock.json').packages[''].version, manifest.version);
assert.equal(manifest.wit_version, '0.2.0');
assert.equal(manifest.wasm, 'plugin.wasm');
assert.deepEqual(manifest.capabilities, [{
  kind: 'http',
  allowed_origins: ['https://codexradar.com', 'https://deepswe.datacurve.ai', 'https://cdk.aixhan.com'],
}]);
assert.equal(manifest.contributions.traffic_policy, false);
assert.equal(manifest.contributions.request_rewrite, false);
assert.equal(manifest.contributions.configuration, null);
assert.deepEqual(manifest.contributions.providers, []);
assert.equal(manifest.contributions.service_data.length, 1);
assert.equal(manifest.contributions.operator_ui.length, 1);

const endpoint = manifest.contributions.service_data[0];
assert.equal(endpoint.id, 'health-intelligence');
assert.equal(endpoint.url, undefined);
assert.deepEqual(endpoint.component_adapter, { api_version: 'component-v1', collector: 'health-three-source-v1', normalizer: 'health-snapshot-v1', config: json('component/sources.json') });
assert.equal(endpoint.required_scope, 'metrics:read');
assert.deepEqual(endpoint.response_schema, reviewedSchema);
assert.equal(endpoint.cache_ttl_seconds, 300);
assert.equal(endpoint.timeout_millis, 30000);
assert.equal(endpoint.max_body_bytes, 1_048_576);
assert.equal(endpoint.fallback.schemaVersion, 1);
assert.deepEqual(endpoint.fallback.sources.map((source) => source.id), ['codexradar', 'deepswe', 'aixhan']);
assert(endpoint.fallback.sources.every((source) => source.status === 'error' && source.rows.length === 0));

const tab = manifest.contributions.operator_ui[0];
assert.deepEqual(tab, {
  id: 'health-and-intelligence',
  slot: 'operator.sidebar.tab',
  category: { id: 'monitoring' },
  route: 'health-intelligence',
  label: '模型健康与能力',
  icon: 'heart',
  renderer: 'component_v1',
  module_entry: 'ui/health-intelligence.mjs',
  component_id: 'health-intelligence',
  data_endpoint: 'health-intelligence',
});

assert.equal(installerTrust.format_version, 1);
assert.equal(installerTrust.status, 'ready');
assert.match(installerTrust.host_contract_revision, /^[0-9a-f]{40}$/);
assert.equal(installerTrust.installer_repository, 'ghcr.io/memeloop-online/memeloop-token-center-plugin-installer');
assert.match(installerTrust.installer_digest, /^sha256:[0-9a-f]{64}$/);
assert.match(installerTrust.installer_source_revision, /^[0-9a-f]{40}$/);
assert.equal(installerTrust.minimum_installer_contract_revision, installerTrust.host_contract_revision);
assert.equal(installerTrust.installer_verification_run, 'https://github.com/memeloop-online/memeloop-token-center/actions/runs/37914361285');
assert.equal(installerTrust.cosign_version, 'v3.1.3-mtc.3');

const sources = read('src/server/sources.ts');
for (const expected of [
  'https://codexradar.com/api/radar-insights',
  'https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json',
  'https://cdk.aixhan.com/api/public/check-cx/dashboard',
]) assert(sources.includes(expected));

const forbidden = [
  ['.example', 'invalid'].join('.'),
  ['mtc-transient', 'health'].join('-'),
  ['group-routing', 'v2'].join('-'),
  ['<', 'iframe'].join(''),
  ['dangerouslySet', 'InnerHTML'].join(''),
  ['BEGIN PRIVATE', 'KEY'].join(' '),
];
const textExtensions = new Set(['.json', '.md', '.mjs', '.ts', '.yml', '.yaml']);
function scan(directory) {
  for (const name of readdirSync(directory)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist' || name === 'site'
        || name === 'mtc-core' || name === 'mtc-installer-contract') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      scan(path);
      continue;
    }
    if (!textExtensions.has(extname(path))) continue;
    const value = readFileSync(path, 'utf8');
    for (const needle of forbidden) {
      assert(!value.includes(needle), `${relative(root, path)} contains forbidden text: ${needle}`);
    }
  }
}
scan(root);

const coreRoot = process.argv[2];
if (coreRoot) {
  assert.equal(execFileSync('git', ['-C', coreRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    installerTrust.host_contract_revision, 'host checkout differs from the reviewed trust revision');
  assert.equal(read('wit/token-center.wit'), readFileSync(join(coreRoot, 'wit/token-center.wit'), 'utf8'),
    'component WIT must match the exact pinned host ABI');
  const coreSchema = JSON.parse(readFileSync(join(coreRoot, 'schemas/plugin-manifest.schema.json'), 'utf8'));
  const contributions = coreSchema.properties?.contributions?.properties;
  assert(contributions?.service_data, 'pinned MTC schema lacks service_data');
  assert(contributions?.operator_ui, 'pinned MTC schema lacks operator_ui');
  const operatorUi = readFileSync(join(coreRoot, 'web/src/operator/pluginContributions.tsx'), 'utf8');
  assert(operatorUi.includes("renderer === 'component_v1'"));
  const sdk = await import(pathToFileURL(join(coreRoot, 'web/operator-ui-sdk/index.js')).href);
  const module = await import(pathToFileURL(join(root, tab.module_entry)).href);
  const uiPackage = await module.activateOperatorUi({
    apiVersion: sdk.OPERATOR_UI_PACKAGE_API_V1,
    React: {},
    Fluent: { tokens: {}, makeStyles: () => () => ({}) },
    defineOperatorUiPackage: sdk.defineOperatorUiPackage,
  });
  assert(sdk.operatorUiPackageSupportsManifest(uiPackage, manifest.id, manifest.version),
    'UI package identity must satisfy the actual pinned host SDK');
  assert.equal(typeof uiPackage.components[tab.component_id], 'function');
  assert.equal(module.MAX_SOURCES, reviewedSchema.properties.sources.maxItems);
  assert.equal(module.MAX_ROWS, reviewedSchema.$defs.source.properties.rows.maxItems);
  const host = readFileSync(join(coreRoot, 'web/src/plugins/OperatorPluginComponentHost.tsx'), 'utf8');
  assert(host.includes('loadServiceData(endpointId: string, signal?: AbortSignal)'));
  assert(host.includes('Fluent: FluentRuntime') && host.includes('React: ReactRuntime'));
}

const installerRoot = process.argv[3];
if (installerRoot) {
  assert.equal(execFileSync('git', ['-C', installerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    installerTrust.installer_source_revision, 'installer checkout differs from the reviewed trust revision');
  const installerManifestSchema = JSON.parse(readFileSync(join(installerRoot, 'schemas/plugin-manifest.schema.json'), 'utf8'));
  const contributions = installerManifestSchema.properties?.contributions?.properties;
  assert(contributions?.service_data, 'pinned installer schema lacks service_data');
  assert(contributions?.operator_ui, 'pinned installer schema lacks operator_ui');
  const serviceContract = contributions.service_data.items;
  assert(serviceContract.properties?.component_adapter, 'pinned installer lacks component_adapter');
  assert(!serviceContract.required.includes('url'), 'pinned installer still requires URL collection');
  assert.deepEqual(serviceContract.oneOf, [
    { required: ['url'], not: { required: ['component_adapter'] } },
    { required: ['component_adapter'], not: { required: ['url'] } },
  ], 'installer must require exactly one supported collector');
  assert.equal(read('wit/token-center.wit'), readFileSync(join(installerRoot, 'wit/token-center.wit'), 'utf8'),
    'installer ABI must match the component WIT');
  assert(contributions.operator_ui.items?.properties?.renderer?.enum?.includes('component_v1'),
    'pinned installer schema lacks component_v1');

  const pluginSource = readFileSync(join(installerRoot, 'src/plugin.rs'), 'utf8');
  assert(pluginSource.includes('"component_v1"'), 'pinned installer runtime lacks component_v1');
  assert(pluginSource.includes('const PLUGIN_FUEL: u64 = 5_000_000;'));
  assert(pluginSource.includes('const PLUGIN_MEMORY_BYTES: usize = 32 * 1024 * 1024;'));
  assert(pluginSource.includes('const PLUGIN_TABLE_ELEMENTS: usize = 100_000;'));
  assert(pluginSource.includes('const PLUGIN_EPOCH_TICK: Duration = Duration::from_millis(10);'));
  const execution = readFileSync(join(installerRoot, 'src/plugin/service_data.rs'), 'utf8');
  for (const bound of ['.memory_size(PLUGIN_MEMORY_BYTES)', '.table_elements(PLUGIN_TABLE_ELEMENTS)',
    '.instances(8)', '.tables(2)', '.memories(2)', 'store.set_fuel(self.fuel)',
    'store.set_epoch_deadline(epoch_deadline_ticks(timeout))', 'Duration::from_millis(endpoint.timeout_millis)']) {
    assert(execution.includes(bound), `pinned host execution bounds changed: ${bound}`);
  }
  assert(readFileSync(join(installerRoot, 'Cargo.toml'), 'utf8').includes('version = "0.49.9"'),
    'contract validator must use the official pinned validator version');
  assert(pluginSource.includes('validate_service_data_contributions(manifest)?'),
    'pinned installer runtime lacks authoritative service_data validation');

  const schemaSource = readFileSync(join(installerRoot, 'src/schema.rs'), 'utf8');
  const supportedExpression = schemaSource.match(/matches!\(format,\s*([^)]+)\)/s)?.[1];
  assert(supportedExpression, 'could not read pinned installer JSON Schema format allowlist');
  const supportedFormats = new Set([...supportedExpression.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  const declaredFormats = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.format === 'string') declaredFormats.add(value.format);
    Object.values(value).forEach(visit);
  };
  visit(endpoint.response_schema);
  for (const format of declaredFormats) {
    assert(supportedFormats.has(format), `response schema format ${format} is unsupported by the pinned installer`);
  }
}

console.log('health intelligence contracts verified');
