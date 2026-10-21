import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceRoot = process.argv[2];
assert(evidenceRoot, 'release evidence directory is required');
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(evidenceRoot, path));
const json = (path) => JSON.parse(read(path).toString('utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const expectedDigest = process.env.PLUGIN_DIGEST;
const source = process.env.PLUGIN_SOURCE;
assert.match(expectedDigest ?? '', /^sha256:[0-9a-f]{64}$/);
assert.equal(source, 'ghcr.io/memeloop-online/memeloop-token-center-health-intelligence-plugin');

const ociManifestBytes = read('plugin-oci-manifest.json');
assert.equal(sha256(ociManifestBytes), expectedDigest);
const ociManifest = JSON.parse(ociManifestBytes.toString('utf8'));
assert.equal(ociManifest.artifactType, 'application/vnd.memeloop.token-center.plugin.v1');
assert.equal(ociManifest.config.mediaType, 'application/vnd.memeloop.token-center.plugin.config.v1+json');
assert.equal(ociManifest.layers.length, 6);

const mediaTypes = {
  'plugin.wasm': 'application/vnd.wasm.content.layer.v1+wasm',
  'plugin.json': 'application/vnd.memeloop.token-center.plugin.manifest.v1+json',
  'schemas-health-intelligence.json': 'application/vnd.memeloop.token-center.plugin.asset.v1',
  'README.md': 'application/vnd.memeloop.token-center.plugin.asset.v1',
  'LICENSE': 'application/vnd.memeloop.token-center.plugin.asset.v1',
  'ui/health-intelligence.mjs': 'application/vnd.memeloop.token-center.plugin.asset.v1',
};
const files = Object.entries(mediaTypes).map(([name, mediaType]) => {
  const bytes = read(`plugin-package/${name}`);
  const layer = ociManifest.layers.find((entry) => entry.annotations?.['org.opencontainers.image.title'] === name);
  assert(layer, `missing OCI layer ${name}`);
  assert.equal(layer.mediaType, mediaType);
  assert.equal(layer.digest, sha256(bytes));
  assert.equal(layer.size, bytes.length);
  return { name, digest: sha256(bytes), size: bytes.length, media_type: mediaType };
});

const packageManifest = json('plugin-package/plugin.json');
assert.equal(packageManifest.id, 'mtc-health-intelligence');
assert.equal(packageManifest.version, JSON.parse(readFileSync(join(repositoryRoot, 'plugin.json'), 'utf8')).version);
assert.equal(packageManifest.version, '1.2.1');
assert.equal(packageManifest.wasm, 'plugin.wasm');
assert.equal(packageManifest.contributions.operator_ui[0].renderer, 'component_v1');
assert.equal(packageManifest.contributions.operator_ui[0].module_entry, 'ui/health-intelligence.mjs');
assert.equal(packageManifest.contributions.service_data[0].id, 'health-intelligence');

const installed = json('plugin-installation.json');
assert.equal(installed.id, packageManifest.id);
assert.equal(installed.version, packageManifest.version);
assert.equal(installed.digest, expectedDigest);
assert.equal(installed.source, source);

const receipt = json(`plugin-install/${packageManifest.id}/.mtc-oci-install.json`);
assert.equal(receipt.format_version, 1);
assert.equal(receipt.signature_policy, 'cosign-keyless');
assert.equal(receipt.digest, expectedDigest);
assert.equal(receipt.source, source);

const verification = json('plugin-signature-verification.json');
assert(Array.isArray(verification) && verification.length > 0);
assert(verification.some((entry) =>
  entry.critical?.image?.['docker-manifest-digest'] === expectedDigest));

const trust = JSON.parse(readFileSync(join(repositoryRoot, 'release/installer-trust.json'), 'utf8'));
assert.equal(trust.status, 'ready');
const evidence = {
  format_version: 1,
  plugin_id: packageManifest.id,
  version: packageManifest.version,
  reference: `${source}@${expectedDigest}`,
  git_sha: process.env.GITHUB_SHA,
  workflow_run: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  service_data_component: packageManifest.contributions.service_data[0].component_adapter,
  wasm_sha256: sha256(read('plugin-package/plugin.wasm')),
  signature: {
    policy: 'cosign-keyless',
    issuer: process.env.SIGNING_ISSUER,
    identity: process.env.SIGNING_IDENTITY,
  },
  installer_reference: `${trust.installer_repository}@${trust.installer_digest}`,
  installer_source_revision: trust.installer_source_revision,
  compatible_core_revision: trust.host_contract_revision,
  files,
  installation_verified: true,
  manifest_verified_by: 'MTC official install-plugin-oci',
};
writeFileSync(join(evidenceRoot, 'plugin-release.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log('signed component release evidence verified');
