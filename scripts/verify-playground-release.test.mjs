import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(root, 'scripts/verify-playground-release.mjs');
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source = 'ghcr.io/memeloop-online/memeloop-token-center-text-playground-plugin';
const identity = 'https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-playground.yml@refs/heads/master';

test('release verifier accepts exact signed-installed evidence and rejects independent tampering', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'playground-release-'));
  const write = (path, bytes) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), bytes); };
  const json = (path, value) => write(path, JSON.stringify(value));
  try {
    const manifest = readFileSync(join(root, 'playground/plugin.json'));
    const packageManifest = JSON.parse(manifest);
    const files = { 'plugin.json': manifest, 'ui/playground.mjs': Buffer.from('export const mount = () => {};'), 'README.md': Buffer.from('Read me'), LICENSE: Buffer.from('License'), 'THIRD_PARTY_NOTICES.md': Buffer.from('Notices') };
    for (const [name, bytes] of Object.entries(files)) {
      write(`plugin-package/${name}`, bytes);
      write(`plugin-install/mtc-text-playground/${name}`, bytes);
    }
    const config = Buffer.from('{"format_version":1}\n');
    write('plugin-package/config.json', config);
    const sha = 'a'.repeat(40);
    const oci = { artifactType: 'application/vnd.memeloop.token-center.plugin.v1', config: { mediaType: 'application/vnd.memeloop.token-center.plugin.config.v1+json', digest: hash(config), size: config.length }, annotations: { 'org.opencontainers.image.revision': sha }, layers: Object.entries(files).map(([name, bytes]) => ({ annotations: { 'org.opencontainers.image.title': name }, digest: hash(bytes), size: bytes.length, mediaType: name === 'plugin.json' ? 'application/vnd.memeloop.token-center.plugin.manifest.v1+json' : 'application/vnd.memeloop.token-center.plugin.asset.v1' })) };
    const ociBytes = Buffer.from(JSON.stringify(oci));
    const digest = hash(ociBytes);
    write('plugin-oci-manifest.json', ociBytes);
    json('plugin-installation.json', { id: packageManifest.id, version: packageManifest.version, source, digest });
    json('plugin-install/mtc-text-playground/.mtc-oci-install.json', { format_version: 1, signature_policy: 'cosign-keyless', source, digest });
    json('plugin-signature-verification.json', [{ critical: { image: { 'docker-manifest-digest': digest } } }]);
    json('dist/playground/package-evidence.json', { source_revision: sha, plugin_id: packageManifest.id, version: packageManifest.version, module_sha256: hash(files['ui/playground.mjs']), files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) });
    write('release/installer-trust.json', readFileSync(join(root, 'release/installer-trust.json')));
    const env = { ...process.env, PLUGIN_SOURCE: source, PLUGIN_DIGEST: digest, SIGNING_IDENTITY: identity, SIGNING_ISSUER: 'https://token.actions.githubusercontent.com', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'memeloop-online/memeloop-token-center-example-plugins', GITHUB_RUN_ID: '1' };
    const run = overrides => spawnSync(process.execPath, [verifier, fixture], { cwd: fixture, env: { ...env, ...overrides }, encoding: 'utf8' });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(readFileSync(join(fixture, 'plugin-release.json'))).reference, `${source}@${digest}`);
    assert.notEqual(run({ SIGNING_IDENTITY: 'https://untrusted.invalid' }).status, 0);
    write('plugin-install/mtc-text-playground/ui/playground.mjs', 'tampered installation');
    assert.notEqual(run().status, 0);
    write('plugin-install/mtc-text-playground/ui/playground.mjs', files['ui/playground.mjs']);
    write('plugin-package/ui/playground.mjs', 'tampered publication');
    assert.notEqual(run().status, 0);
    write('plugin-package/ui/playground.mjs', files['ui/playground.mjs']);
    json('plugin-signature-verification.json', [{ critical: { image: { 'docker-manifest-digest': `sha256:${'0'.repeat(64)}` } } }]);
    assert.notEqual(run().status, 0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
