import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const evidenceRoot = process.argv[2];
assert(evidenceRoot, 'release evidence directory is required');
const read = path => readFileSync(join(evidenceRoot, path));
const json = path => JSON.parse(read(path).toString('utf8'));
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source = 'ghcr.io/memeloop-online/memeloop-token-center-text-playground-plugin';
const identity = 'https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-playground.yml@refs/heads/master';
const issuer = 'https://token.actions.githubusercontent.com';
const digest = process.env.PLUGIN_DIGEST;
assert.equal(process.env.PLUGIN_SOURCE, source);
assert.equal(process.env.SIGNING_IDENTITY, identity);
assert.equal(process.env.SIGNING_ISSUER, issuer);
assert.match(digest ?? '', /^sha256:[0-9a-f]{64}$/);
assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
const rawManifest = read('plugin-oci-manifest.json');
assert.equal(hash(rawManifest), digest, 'OCI manifest must match signed digest');
const oci = JSON.parse(rawManifest);
assert.equal(oci.schemaVersion, 2);
assert.equal(oci.mediaType, 'application/vnd.oci.image.manifest.v1+json');
assert.equal(oci.annotations?.['org.opencontainers.image.source'], 'https://github.com/memeloop-online/memeloop-token-center-example-plugins');
assert.equal(oci.artifactType, 'application/vnd.memeloop.token-center.plugin.v1');
assert.equal(oci.config.mediaType, 'application/vnd.memeloop.token-center.plugin.config.v1+json');
assert.equal(oci.config.digest, hash(read('plugin-package/config.json')));
assert.equal(oci.config.size, read('plugin-package/config.json').length);
assert.equal(oci.annotations['org.opencontainers.image.revision'], process.env.GITHUB_SHA);
const names = ['plugin.json', 'ui/playground.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
assert.equal(oci.layers.length, names.length);
const build = JSON.parse(readFileSync('dist/playground/package-evidence.json', 'utf8'));
assert.equal(build.source_revision, process.env.GITHUB_SHA);
assert.equal(build.plugin_id, 'mtc-text-playground');
const files = names.map(name => {
  const bytes = read(`plugin-package/${name}`);
  const matching = oci.layers.filter(layer => layer.annotations?.['org.opencontainers.image.title'] === name);
  assert.equal(matching.length, 1, `one exact layer required for ${name}`);
  const mediaType = name === 'plugin.json' ? 'application/vnd.memeloop.token-center.plugin.manifest.v1+json' : 'application/vnd.memeloop.token-center.plugin.asset.v1';
  assert.equal(matching[0].mediaType, mediaType);
  assert.equal(matching[0].digest, hash(bytes));
  assert.equal(matching[0].size, bytes.length);
  assert.equal(build.files[name], hash(bytes), 'published bytes must match the built package');
  assert.deepEqual(read(`plugin-install/mtc-text-playground/${name}`), bytes, `clean-installed ${name}`);
  return { name, digest: hash(bytes), size: bytes.length, media_type: mediaType };
});
const manifest = json('plugin-package/plugin.json');
assert.equal(manifest.id, 'mtc-text-playground');
assert.equal(manifest.wasm, null);
assert.deepEqual(manifest.capabilities, []);
assert.equal(manifest.version, build.version);
assert.equal(build.module_sha256, hash(read('plugin-package/ui/playground.mjs')));
assert.deepEqual(manifest.contributions.operator_ui.map(item => item.component_id), ['workspace', 'open-model']);
assert(manifest.contributions.operator_ui.every(item => item.renderer === 'component_v1' && item.module_entry === 'ui/playground.mjs'));
const installed = json('plugin-installation.json');
for (const [key, expected] of Object.entries({ id: manifest.id, version: manifest.version, source, digest })) assert.equal(installed[key], expected);
const receipt = json('plugin-install/mtc-text-playground/.mtc-oci-install.json');
for (const [key, expected] of Object.entries({ format_version: 1, signature_policy: 'cosign-keyless', source, digest })) assert.equal(receipt[key], expected);
const signatures = json('plugin-signature-verification.json');
assert(Array.isArray(signatures) && signatures.some(entry => entry.critical?.image?.['docker-manifest-digest'] === digest));
const trust = JSON.parse(readFileSync('release/playground-installer-trust.json', 'utf8'));
assert.equal(trust.status, 'ready');
assert.match(trust.installer_digest ?? '', /^sha256:[0-9a-f]{64}$/);
assert.match(trust.installer_source_revision ?? '', /^[0-9a-f]{40}$/);
const release = {
  format_version: 1, plugin_id: manifest.id, version: manifest.version,
  reference: `${source}@${digest}`, git_sha: process.env.GITHUB_SHA,
  workflow_run: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  signature: { policy: 'cosign-keyless', issuer, identity },
  installer_reference: `${trust.installer_repository}@${trust.installer_digest}`,
  installer_source_revision: trust.installer_source_revision,
  installer_verification_run: trust.installer_verification_run,
  minimum_installer_contract_revision: trust.minimum_installer_contract_revision,
  module_sha256: build.module_sha256, memeloop_revision: build.memeloop_revision,
  files, installation_verified: true, manifest_verified_by: 'MTC official install-plugin-oci',
};
writeFileSync(join(evidenceRoot, 'plugin-release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log('Signed playground OCI bytes and official clean installation verified');
