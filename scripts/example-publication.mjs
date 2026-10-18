import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Only this master-reviewed table selects executable inputs, paths and sources.
// workflow_dispatch accepts its keys, never a path, command, ref or registry.
const packages = Object.freeze({
  'model-guard': {
    id: 'mtc-model-guard', directory: 'plugin-sources/model-guard',
    source: 'ghcr.io/memeloop-online/mtc-model-guard',
    files: ['plugin.json', 'plugin.wasm', 'README.md', 'LICENSE'],
  },
  'preferred-account': {
    id: 'mtc-preferred-account', directory: 'plugin-sources/preferred-account',
    source: 'ghcr.io/memeloop-online/mtc-preferred-account',
    files: ['plugin.json', 'plugin.wasm', 'README.md', 'LICENSE'],
  },
  'soonest-reset': {
    id: 'mtc-soonest-reset', directory: 'plugin-sources/soonest-reset',
    source: 'ghcr.io/memeloop-online/mtc-soonest-reset',
    files: ['plugin.json', 'plugin.wasm', 'README.md', 'LICENSE'],
  },
  'google-antigravity': {
    id: 'google-antigravity', directory: 'plugins/google-antigravity',
    source: 'ghcr.io/memeloop-online/mtc-google-antigravity',
    files: ['plugin.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  },
  'policy-rewrite': {
    id: 'example-policy-rewrite', directory: 'examples/plugins/policy-rewrite',
    source: 'ghcr.io/memeloop-online/mtc-example-policy-rewrite',
    files: ['plugin.json', 'plugin.wasm', 'README.md', 'LICENSE'],
  },
});
const repository = 'memeloop-online/memeloop-token-center-example-plugins';
const identity = `https://github.com/${repository}/.github/workflows/publish-examples.yml@refs/heads/master`;
const issuer = 'https://token.actions.githubusercontent.com';
const manifestType = 'application/vnd.memeloop.token-center.plugin.manifest.v1+json';
const assetType = 'application/vnd.memeloop.token-center.plugin.asset.v1';
const configType = 'application/vnd.memeloop.token-center.plugin.config.v1+json';
const artifactType = 'application/vnd.memeloop.token-center.plugin.v1';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const mediaType = name => name === 'plugin.json' ? manifestType : name === 'plugin.wasm' ? 'application/vnd.wasm.content.layer.v1+wasm' : assetType;
const trust = json('release/examples-installer-trust.json');
const dist = resolve('dist/examples');

function requireTrust() {
  assert.equal(trust.format_version, 1);
  assert.equal(trust.status, 'ready');
  assert.equal(trust.host_repository, 'memeloop-online/memeloop-token-center');
  assert.equal(trust.installer_repository, 'ghcr.io/memeloop-online/memeloop-token-center-plugin-installer');
  for (const key of ['host_source_revision', 'installer_source_revision', 'minimum_installer_contract_revision', 'host_fixture_revision']) {
    assert.match(trust[key] ?? '', /^[0-9a-f]{40}$/);
  }
  assert.equal(trust.host_source_revision, trust.installer_source_revision);
  assert.equal(trust.minimum_installer_contract_revision, trust.installer_source_revision);
  assert.match(trust.installer_digest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.match(trust.host_reference ?? '', /^ghcr\.io\/memeloop-online\/memeloop-token-center@sha256:[0-9a-f]{64}$/);
  assert.match(trust.cosign_version ?? '', /^v\d+\.\d+\.\d+-mtc\.\d+$/);
  assert.match(trust.verification_run ?? '', /^https:\/\/github\.com\/memeloop-online\/memeloop-token-center\/actions\/runs\/[0-9]+$/);
  assert(Number.isSafeInteger(trust.release_artifact_id) && trust.release_artifact_id > 0);
  assert.equal(trust.release_artifact_name, `ghcr-release-${trust.host_source_revision}`);
  assert.match(trust.release_artifact_digest ?? '', /^sha256:[0-9a-f]{64}$/);
}

function selectedPackage() {
  const name = process.env.REQUESTED_EXAMPLE_PACKAGE;
  assert(typeof name === 'string' && Object.hasOwn(packages, name), 'unknown example publication package');
  return { name, ...packages[name] };
}

function environment(values) {
  assert(process.env.GITHUB_ENV, 'GitHub environment file is required');
  for (const value of Object.values(values)) assert(!/[\r\n]/.test(String(value)));
  appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function sourceRevision() {
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  return process.env.GITHUB_SHA;
}

function validateManifest(item, manifest) {
  assert.equal(manifest.id, item.id);
  assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.wit_version, '0.2.0');
  if (item.id === 'mtc-model-guard') {
    assert.equal(manifest.wasm, 'plugin.wasm');
    assert.deepEqual(manifest.capabilities, []);
    assert.equal(manifest.contributions.traffic_policy, true);
    assert.deepEqual(manifest.contributions.configuration.default, { blocked_models: [] });
  } else if (item.id === 'mtc-preferred-account') {
    assert.equal(manifest.wasm, 'plugin.wasm');
    assert.deepEqual(manifest.capabilities, []);
    assert.equal(manifest.contributions.group_routing.version, 'group-routing-v1');
    assert.equal(manifest.contributions.group_routing.health_policy, 'native');
    assert.deepEqual(manifest.contributions.group_routing.default, { preferred_account_ids: [] });
  } else if (item.id === 'mtc-soonest-reset') {
    assert.equal(manifest.wasm, 'plugin.wasm');
    assert.deepEqual(manifest.capabilities, [{ kind: 'group_routing_quota' }]);
    assert.equal(manifest.contributions.group_routing.version, 'group-routing-v1');
    assert.equal(manifest.contributions.group_routing.health_policy, 'native');
  } else if (item.id === 'google-antigravity') {
    assert.equal(manifest.wasm, null);
    assert.deepEqual(manifest.capabilities, []);
    assert.deepEqual(manifest.contributions.providers.map(provider => provider.id), ['google-antigravity']);
    assert.equal(manifest.contributions.providers[0].oauth_adapter.flow_kind, 'authorization_code_pkce');
  } else {
    assert.equal(manifest.wasm, 'plugin.wasm');
    assert.deepEqual(manifest.capabilities, []);
    assert.deepEqual(manifest.contributions.configuration.default, { enabled: false });
    const provider = manifest.contributions.providers[0];
    assert.equal(provider.id, 'example-oauth-http');
    assert.deepEqual(provider.protocols, ['openai']);
    assert.deepEqual(provider.modalities, ['text']);
    assert.equal(provider.config_schema.properties.development_fixture.const, true);
    assert(provider.config_schema.required.includes('development_fixture'));
  }
}

function packageHashes(item, directory) {
  const expected = [...item.files, 'config.json'].sort();
  assert.deepEqual(readdirSync(directory).sort(), expected, 'package must contain only the fixed file allowlist');
  return Object.fromEntries(expected.map(name => [name, hash(readFileSync(join(directory, name)))]));
}

async function resolveTrust() {
  requireTrust();
  const runId = trust.verification_run.split('/').at(-1);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const get = async path => {
    const response = await fetch(`https://api.github.com/repos/${trust.host_repository}/${path}`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    assert(response.ok, `cannot verify official CI evidence: HTTP ${response.status}`);
    return response.json();
  };
  const run = await get(`actions/runs/${runId}`);
  assert.equal(run.conclusion, 'success');
  assert.equal(run.head_sha, trust.host_source_revision);
  assert.equal(run.repository.full_name, trust.host_repository);
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.event, 'push');
  assert.equal(run.head_branch, 'master');
  environment({
    HOST_SOURCE_REVISION: trust.host_source_revision, HOST_FIXTURE_REVISION: trust.host_fixture_revision,
    HOST_REFERENCE: trust.host_reference, OFFICIAL_VERIFICATION_RUN_ID: runId,
    OFFICIAL_RELEASE_ARTIFACT: trust.release_artifact_name,
    INSTALLER_SOURCE: trust.installer_repository, INSTALLER_DIGEST: trust.installer_digest,
    INSTALLER_SOURCE_REVISION: trust.installer_source_revision, COSIGN_VERSION: trust.cosign_version,
  });
}

function verifyPins() {
  requireTrust();
  // Reviewed snapshot preserves the official release metadata beyond Actions
  // retention. Executable trust is the reviewed immutable digest plus the
  // successful official source CI, never an image's self-reported labels.
  const snapshot = json('release/examples-publication-metadata.json');
  assert.equal(snapshot.format_version, 1);
  assert.equal(snapshot.verification_run, trust.verification_run);
  assert.equal(snapshot.artifact_name, trust.release_artifact_name);
  assert.equal(snapshot.artifact_digest, trust.release_artifact_digest);
  const metadata = snapshot.release_manifest;
  assert(Array.isArray(metadata));
  assert.equal(metadata.length, 2);
  for (const [image, reference] of [
    ['ghcr.io/memeloop-online/memeloop-token-center', trust.host_reference],
    [trust.installer_repository, `${trust.installer_repository}@${trust.installer_digest}`],
  ]) {
    const entries = metadata.filter(entry => entry.image === image);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].revision, trust.host_source_revision);
    assert.equal(entries[0].reference, reference);
    assert.equal(`${image}@${entries[0].digest}`, reference);
    assert.equal(entries[0].tag, `sha-${trust.host_source_revision}`);
  }
}

function assemble() {
  for (const [name, item] of Object.entries(packages)) {
    const directory = join(dist, 'packages', item.id);
    mkdirSync(directory, { recursive: true });
    for (const file of item.files) {
      const source = file === 'LICENSE' ? file : file === 'plugin.wasm'
        ? join(process.env.RUNNER_TEMP, 'example-components', `${name}.wasm`)
        : join(item.directory, file);
      copyFileSync(source, join(directory, file));
    }
    writeFileSync(join(directory, 'config.json'), '{"format_version":1}\n');
    validateManifest(item, json(join(directory, 'plugin.json')));
    if (item.files.includes('plugin.wasm')) {
      assert.equal(readFileSync(join(directory, 'plugin.wasm')).subarray(0, 8).toString('hex'), '0061736d0d000100');
    }
  }
}

function candidate() {
  const wasm = readFileSync(join(process.env.RUNNER_TEMP, 'example-components/policy-rewrite.wasm'));
  assert.equal(wasm.subarray(0, 8).toString('hex'), '0061736d0d000100');
  writeJson(join(process.env.RUNNER_TEMP, 'example-components/policy-rewrite-candidate.json'), {
    format_version: 1, plugin_id: 'example-policy-rewrite', source_revision: sourceRevision(),
    source_wat_sha256: hash(readFileSync('examples/plugins/policy-rewrite/plugin.wat')),
    wit_sha256: hash(readFileSync('wit/token-center.wit')), wasm_sha256: hash(wasm),
    wasm_tools_version: '1.252.0',
    acceptance_scope: 'Compiled component and direct core ABI checks only; not host-verified or signed.',
    host_verified: false, signed: false,
  });
}

function review() {
  requireTrust();
  const revision = sourceRevision();
  const hostRevision = execFileSync('git', ['-C', join(process.env.RUNNER_TEMP, 'example-publication-host'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(hostRevision, trust.host_source_revision);
  mkdirSync(join(dist, 'review'), { recursive: true });
  mkdirSync(join(dist, 'archives'), { recursive: true });
  const checksums = [];
  for (const [name, item] of Object.entries(packages)) {
    const directory = join(dist, 'packages', item.id);
    const manifest = json(join(directory, 'plugin.json'));
    validateManifest(item, manifest);
    const files = packageHashes(item, directory);
    const evidence = {
      format_version: 1, package: name, plugin_id: item.id, version: manifest.version,
      source_revision: revision, intended_oci_source: item.source, files,
      host_source_revision: hostRevision, host_verification_run: trust.verification_run,
      host_reference: trust.host_reference,
      host_acceptance: name === 'soonest-reset'
        ? ['first_party_soonest_reset', 'soonest_reset_real_gateway']
        : ['example_publication'],
      acceptance_scope: 'Real MTC host/component contract fixture; no live supplier login, quota fetch or paid inference.',
      signed: false,
    };
    writeJson(join(dist, 'review', `${item.id}.json`), evidence);
    const archive = `${item.id}-${manifest.version}.tar.gz`;
    execFileSync('tar', ['-czf', join(dist, 'archives', archive), '-C', directory, ...item.files]);
    checksums.push(`${hash(readFileSync(join(dist, 'archives', archive))).slice(7)}  ${archive}`);
  }
  writeFileSync(join(dist, 'archives/SHA256SUMS'), `${checksums.join('\n')}\n`);
}

function select() {
  const item = selectedPackage();
  const evidence = json(join(dist, 'review', `${item.id}.json`));
  const directory = join(dist, 'packages', item.id);
  assert.equal(evidence.source_revision, sourceRevision());
  assert.equal(evidence.plugin_id, item.id);
  assert.equal(evidence.intended_oci_source, item.source);
  assert.equal(evidence.host_source_revision, trust.host_source_revision);
  assert.deepEqual(evidence.files, packageHashes(item, directory));
  validateManifest(item, json(join(directory, 'plugin.json')));
  const destination = join(process.env.RUNNER_TEMP, 'plugin-package');
  mkdirSync(destination);
  for (const file of [...item.files, 'config.json']) copyFileSync(join(directory, file), join(destination, file));
  copyFileSync(join(dist, 'review', `${item.id}.json`), join(process.env.RUNNER_TEMP, 'plugin-build.json'));
  environment({ PLUGIN_ID: item.id, PLUGIN_SOURCE: item.source, SIGNING_IDENTITY: identity, SIGNING_ISSUER: issuer });
}

function push() {
  const item = selectedPackage();
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
  const args = ['push', `${item.source}:sha-${sourceRevision()}-run-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    '--artifact-type', artifactType, '--config', `config.json:${configType}`,
    '--annotation', `org.opencontainers.image.source=https://github.com/${repository}`,
    '--annotation', `org.opencontainers.image.revision=${sourceRevision()}`,
    ...item.files.map(name => `${name}:${mediaType(name)}`), '--format', 'json'];
  const result = execFileSync('oras', args, { cwd: join(process.env.RUNNER_TEMP, 'plugin-package'), encoding: 'utf8' });
  const value = JSON.parse(result);
  assert.match(value.digest ?? '', /^sha256:[0-9a-f]{64}$/);
  writeFileSync(join(process.env.RUNNER_TEMP, 'plugin-push.json'), result);
  environment({ PLUGIN_DIGEST: value.digest });
}

function release() {
  requireTrust();
  const item = selectedPackage();
  for (const [key, expected] of Object.entries({ PLUGIN_ID: item.id, PLUGIN_SOURCE: item.source, SIGNING_IDENTITY: identity, SIGNING_ISSUER: issuer })) assert.equal(process.env[key], expected);
  const digest = process.env.PLUGIN_DIGEST;
  assert.match(digest ?? '', /^sha256:[0-9a-f]{64}$/);
  const root = process.env.RUNNER_TEMP;
  const read = path => readFileSync(join(root, path));
  const raw = read('plugin-oci-manifest.json');
  assert.equal(hash(raw), digest);
  const oci = JSON.parse(raw);
  assert.equal(oci.schemaVersion, 2);
  assert.equal(oci.mediaType, 'application/vnd.oci.image.manifest.v1+json');
  assert.equal(oci.artifactType, artifactType);
  assert.equal(oci.annotations['org.opencontainers.image.source'], `https://github.com/${repository}`);
  assert.equal(oci.annotations['org.opencontainers.image.revision'], sourceRevision());
  assert.equal(oci.config.mediaType, configType);
  assert.equal(oci.config.digest, hash(read('plugin-package/config.json')));
  assert.equal(oci.config.size, read('plugin-package/config.json').length);
  assert.equal(oci.layers.length, item.files.length);
  const build = json(join(root, 'plugin-build.json'));
  assert.equal(build.source_revision, sourceRevision());
  assert.equal(build.host_source_revision, trust.host_source_revision);
  const manifest = json(join(root, 'plugin-package/plugin.json'));
  validateManifest(item, manifest);
  const files = item.files.map(name => {
    const bytes = read(`plugin-package/${name}`);
    const matches = oci.layers.filter(layer => layer.annotations?.['org.opencontainers.image.title'] === name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].mediaType, mediaType(name));
    assert.equal(matches[0].digest, hash(bytes));
    assert.equal(matches[0].size, bytes.length);
    assert.equal(build.files[name], hash(bytes));
    assert.deepEqual(read(`plugin-install/${item.id}/${name}`), bytes);
    return { name, digest: hash(bytes), size: bytes.length, media_type: mediaType(name) };
  });
  const installed = json(join(root, 'plugin-installation.json'));
  for (const [key, expected] of Object.entries({ id: item.id, version: manifest.version, source: item.source, digest })) assert.equal(installed[key], expected);
  const receipt = json(join(root, `plugin-install/${item.id}/.mtc-oci-install.json`));
  for (const [key, expected] of Object.entries({ format_version: 1, signature_policy: 'cosign-keyless', source: item.source, digest })) assert.equal(receipt[key], expected);
  const signatures = json(join(root, 'plugin-signature-verification.json'));
  assert(Array.isArray(signatures) && signatures.some(entry => entry.critical?.image?.['docker-manifest-digest'] === digest));
  writeJson(join(root, 'plugin-release.json'), {
    format_version: 1, plugin_id: item.id, version: manifest.version,
    reference: `${item.source}@${digest}`, git_sha: sourceRevision(),
    workflow_run: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    signature: { policy: 'cosign-keyless', issuer, identity },
    installer_reference: `${trust.installer_repository}@${trust.installer_digest}`,
    installer_source_revision: trust.installer_source_revision,
    installer_verification_run: trust.verification_run,
    host_reference: trust.host_reference, host_source_revision: trust.host_source_revision,
    files, host_acceptance: build.host_acceptance, installation_verified: true,
    manifest_verified_by: 'MTC official install-plugin-oci',
    registry_access: 'workflow-token; verify anonymous content and signature access before production installation',
    acceptance_scope: build.acceptance_scope,
  });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Signed ${item.id}\n\nReference: \`${item.source}@${digest}\`\n\nIdentity: \`${identity}\`\n\nIssuer: \`${issuer}\`\n\nOfficial installer clean installation and pinned host fixtures passed. Live provider authorization and inference remain separate operator acceptance.\n`);
}

const commands = { resolve: resolveTrust, 'verify-pins': verifyPins, candidate, assemble, review, select, push, release };
assert(Object.hasOwn(commands, process.argv[2]), 'unknown example publication command');
await commands[process.argv[2]]();
