import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { checkManifest, evidence, requireReadyTrust } from './codex-reset-publication.mjs';

const script = resolve('scripts/codex-reset-publication.mjs');
const manifest = JSON.parse(readFileSync('plugin-sources/codex-expiring-reset/plugin.json', 'utf8'));
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const revision = 'a'.repeat(40);
const identity = 'https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-codex-expiring-reset.yml@refs/heads/master';
const issuer = 'https://token.actions.githubusercontent.com';
const source = 'ghcr.io/memeloop-online/mtc-codex-expiring-reset';
const config = '{"format_version":1}\n';
const files = ['LICENSE', 'README.md', 'plugin.json', 'plugin.wasm', 'ui/codex-expiring-reset.mjs'];
const ready = {
  format_version: 1, status: 'ready', host_repository: 'memeloop-online/memeloop-token-center',
  host_source_revision: revision, host_reference: `ghcr.io/memeloop-online/memeloop-token-center@sha256:${'b'.repeat(64)}`,
  host_verification_run: 'https://github.com/memeloop-online/memeloop-token-center/actions/runs/123',
  host_release_artifact_id: 99, host_release_artifact_digest: `sha256:${'c'.repeat(64)}`,
  installer_repository: 'ghcr.io/memeloop-online/memeloop-token-center-plugin-installer',
  installer_digest: `sha256:${'d'.repeat(64)}`, installer_source_revision: revision,
  minimum_installer_contract_revision: revision, cosign_version: 'v3.1.3-mtc.4',
  installer_verification_run: 'https://github.com/memeloop-online/memeloop-token-center/actions/runs/123',
  plugin_source: source,
};
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-publication-contract-'));
  for (const path of ['release', 'plugin-sources/codex-expiring-reset', 'dist/codex-expiring-reset/ui', 'temp/plugin-package/ui', 'temp/plugin-install/mtc-codex-expiring-reset/ui']) mkdirSync(join(root, path), { recursive: true });
  json(join(root, 'release/codex-expiring-reset-trust.json'), ready);
  json(join(root, 'plugin-sources/codex-expiring-reset/plugin.json'), manifest);
  const directory = join(root, 'dist/codex-expiring-reset');
  for (const path of files) writeFileSync(join(directory, path), path === 'plugin.json' ? JSON.stringify(manifest) : path === 'plugin.wasm' ? Buffer.from('0061736d0d000100', 'hex') : `synthetic ${path}`);
  writeFileSync(join(directory, 'config.json'), config);
  cpSync(directory, join(root, 'temp/plugin-package'), { recursive: true });
  for (const path of files) cpSync(join(directory, path), join(root, 'temp/plugin-install/mtc-codex-expiring-reset', path));
  json(join(root, 'dist/codex-expiring-reset-build.json'), {
    format_version: 1, plugin_id: manifest.id, version: manifest.version, source_revision: revision,
    files: evidence(directory), signed: false, host_acceptance: 'synthetic contract test',
  });
  const oci = {
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.memeloop.token-center.plugin.v1',
    annotations: { 'org.opencontainers.image.source': 'https://github.com/memeloop-online/memeloop-token-center-example-plugins', 'org.opencontainers.image.revision': revision },
    config: { mediaType: 'application/vnd.memeloop.token-center.plugin.config.v1+json', digest: hash(config), size: Buffer.byteLength(config) },
    layers: files.map(path => {
      const bytes = readFileSync(join(directory, path));
      return { mediaType: path === 'plugin.json' ? 'application/vnd.memeloop.token-center.plugin.manifest.v1+json' : path === 'plugin.wasm' ? 'application/vnd.wasm.content.layer.v1+wasm' : 'application/vnd.memeloop.token-center.plugin.asset.v1',
        digest: hash(bytes), size: bytes.length, annotations: { 'org.opencontainers.image.title': path } };
    }),
  };
  const env = { ...process.env, RUNNER_TEMP: join(root, 'temp'), GITHUB_SHA: revision,
    GITHUB_REPOSITORY: 'memeloop-online/memeloop-token-center-example-plugins',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', GITHUB_REF_PROTECTED: 'true',
    GITHUB_WORKFLOW_REF: 'memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-codex-expiring-reset.yml@refs/heads/master',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_ENV: join(root, 'env'), GITHUB_STEP_SUMMARY: join(root, 'summary'),
    SIGNING_IDENTITY: identity, SIGNING_ISSUER: issuer, PLUGIN_ID: manifest.id, PLUGIN_SOURCE: source,
    PATH: `${join(root, 'temp')}${delimiter}${process.env.PATH}` };
  const seal = () => {
    json(join(root, 'temp/plugin-oci-manifest.json'), oci);
    env.PLUGIN_DIGEST = hash(readFileSync(join(root, 'temp/plugin-oci-manifest.json')));
    json(join(root, 'temp/plugin-signature-verification.json'), [{ critical: { image: { 'docker-manifest-digest': env.PLUGIN_DIGEST } } }]);
    json(join(root, 'temp/plugin-install/mtc-codex-expiring-reset/.mtc-oci-install.json'), { format_version: 1, signature_policy: 'cosign-keyless', source, digest: env.PLUGIN_DIGEST });
    json(join(root, 'temp/plugin-installation.json'), { id: manifest.id, version: manifest.version, source, digest: env.PLUGIN_DIGEST });
  };
  seal();
  writeFileSync(join(root, 'temp/gh'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.RUNNER_TEMP+"/gh-args.json",JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const run = command => spawnSync(process.execPath, [script, command], { cwd: root, env, encoding: 'utf8' });
  return { root, env, oci, seal, run, directory, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('pending official pins reject signing and require a complete new release', () => {
  const actual = JSON.parse(readFileSync('release/codex-expiring-reset-trust.json', 'utf8'));
  assert(['pending', 'ready'].includes(actual.status));
  if (actual.status === 'ready') requireReadyTrust(actual);
  const pending = { ...ready, status: 'pending' };
  assert.throws(() => requireReadyTrust(pending), /signing is disabled/);
  requireReadyTrust(ready);
  for (const field of ['host_source_revision', 'host_reference', 'installer_digest', 'host_release_artifact_digest']) {
    assert.throws(() => requireReadyTrust({ ...ready, [field]: '' }), field);
  }
  assert.throws(() => requireReadyTrust({ ...ready, installer_source_revision: 'e'.repeat(40) }));
});

test('only the fixed background planner and operator entry are packageable', () => {
  checkManifest(manifest);
  for (const change of [
    value => { value.capabilities.push({ kind: 'http' }); },
    value => { value.contributions.providers = []; },
    value => { value.contributions.background_actions.interval_seconds = 5; },
    value => { value.contributions.operator_ui[0].module_entry = '../other.mjs'; },
    value => { value.contributions.configuration.default = { enabled: true }; },
  ]) {
    const value = structuredClone(manifest); change(value); assert.throws(() => checkManifest(value));
  }
});

test('recursive allowlist includes exact nested UI and rejects extras and symlinks', () => {
  const value = fixture();
  try {
    assert(evidence(value.directory)['ui/codex-expiring-reset.mjs']);
    writeFileSync(join(value.directory, 'ui/extra.mjs'), 'extra');
    assert.throws(() => evidence(value.directory));
    rmSync(join(value.directory, 'ui/extra.mjs'));
    mkdirSync(join(value.directory, 'extra'));
    assert.throws(() => evidence(value.directory));
    rmSync(join(value.directory, 'extra'), { recursive: true });
    rmSync(join(value.directory, 'ui/codex-expiring-reset.mjs'));
    symlinkSync(join(value.directory, 'README.md'), join(value.directory, 'ui/codex-expiring-reset.mjs'));
    assert.throws(() => evidence(value.directory));
  } finally { value.close(); }
});

test('verifies nested installed bytes, immutable OCI layers and signed digest', () => {
  const value = fixture();
  try {
    const result = value.run('verify-release');
    assert.equal(result.status, 0, result.stderr);
    const release = JSON.parse(readFileSync(join(value.env.RUNNER_TEMP, 'plugin-release.json')));
    assert.equal(release.installation_verified, true);
    assert(release.files.some(file => file.name === 'ui/codex-expiring-reset.mjs'));
  } finally { value.close(); }
});

for (const [name, modify] of [
  ['changed installed UI', value => writeFileSync(join(value.env.RUNNER_TEMP, 'plugin-install/mtc-codex-expiring-reset/ui/codex-expiring-reset.mjs'), 'tampered')],
  ['missing signature', value => json(join(value.env.RUNNER_TEMP, 'plugin-signature-verification.json'), [])],
  ['wrong receipt', value => json(join(value.env.RUNNER_TEMP, 'plugin-install/mtc-codex-expiring-reset/.mtc-oci-install.json'), { format_version: 1, source, digest: value.env.PLUGIN_DIGEST, signature_policy: 'unsigned' })],
  ['wrong OCI media type', value => { value.oci.layers[4].mediaType = 'application/octet-stream'; value.seal(); }],
  ['duplicate OCI path', value => { value.oci.layers.push(value.oci.layers[4]); value.seal(); }],
  ['wrong source annotation', value => { value.oci.annotations['org.opencontainers.image.source'] = 'https://example.invalid'; value.seal(); }],
  ['different signature identity', value => { value.env.SIGNING_IDENTITY = identity.replace('publish-codex-expiring-reset', 'publish-examples'); }],
]) test(`rejects ${name} before a release receipt is written`, () => {
  const value = fixture();
  try {
    modify(value);
    assert.notEqual(value.run('verify-release').status, 0);
    assert.equal(existsSync(join(value.env.RUNNER_TEMP, 'plugin-release.json')), false);
  } finally { value.close(); }
});

test('protected master descriptor uses the dedicated signer and unique release tag', () => {
  const value = fixture();
  try {
    const result = value.run('publish-descriptor');
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(join(value.env.RUNNER_TEMP, 'gh-args.json')));
    assert.deepEqual(args.slice(0, 3), ['release', 'create', `mtc-codex-expiring-reset-${revision}-run-123-2`]);
    assert(args.includes('--latest=false'));
    assert(!args.includes('--clobber'));
    const descriptor = JSON.parse(readFileSync(join(value.env.RUNNER_TEMP, 'mtc-codex-expiring-reset.json')));
    assert.deepEqual(descriptor, { format_version: 1, reference: `${source}@${value.env.PLUGIN_DIGEST}`, signer: { identity, issuer } });
  } finally { value.close(); }
});

for (const [name, field, setting] of [
  ['PR', 'GITHUB_EVENT_NAME', 'pull_request'],
  ['unprotected master', 'GITHUB_REF_PROTECTED', 'false'],
  ['branch', 'GITHUB_REF', 'refs/heads/feature'],
  ['other workflow', 'GITHUB_WORKFLOW_REF', 'other'],
]) test(`rejects descriptor publication from ${name} before invoking gh`, () => {
  const value = fixture();
  try {
    value.env[field] = setting;
    assert.notEqual(value.run('publish-descriptor').status, 0);
    assert.equal(existsSync(join(value.env.RUNNER_TEMP, 'gh-args.json')), false);
  } finally { value.close(); }
});
