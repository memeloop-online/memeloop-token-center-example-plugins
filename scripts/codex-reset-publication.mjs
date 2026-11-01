import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const source = join(root, 'plugin-sources/codex-expiring-reset');
const trust = JSON.parse(readFileSync(join(root, 'release/codex-expiring-reset-trust.json'), 'utf8'));
const files = ['LICENSE', 'README.md', 'plugin.json', 'plugin.wasm', 'ui/codex-expiring-reset.mjs'];
const config = Buffer.from('{"format_version":1}\n');
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = json(join(source, 'plugin.json'));

export function checkManifest(value) {
  assert.equal(value.id, 'mtc-codex-expiring-reset');
  assert.equal(value.version, '1.0.0');
  assert.equal(value.wit_version, '0.2.0');
  assert.equal(value.wasm, 'plugin.wasm');
  assert.deepEqual(value.capabilities, [{ kind: 'quota_reset_credit' }]);
  assert.deepEqual(Object.keys(value.contributions).sort(), ['background_actions', 'configuration', 'operator_ui']);
  assert.deepEqual(value.contributions.background_actions, { interval_seconds: 60 });
  assert.deepEqual(value.contributions.configuration.default, {});
  assert.equal(value.contributions.configuration.schema.type, 'object');
  assert.equal(value.contributions.configuration.schema.additionalProperties, false);
  assert.deepEqual(value.contributions.configuration.schema.properties, {});
  assert.deepEqual(value.contributions.operator_ui.map(({ id, slot, route, renderer, module_entry, component_id }) => ({ id, slot, route, renderer, module_entry, component_id })), [
    { id: 'codex-expiring-reset', slot: 'operator.sidebar.tab', route: 'codex-expiring-reset', renderer: 'component_v1', module_entry: 'ui/codex-expiring-reset.mjs', component_id: 'workspace' },
  ]);
}

function packageRoot() {
  return resolve('dist/codex-expiring-reset');
}

function packageFiles(directory) {
  const found = [];
  const walk = (parent, prefix = '') => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        assert.equal(path, 'ui', 'package directory must be allowlisted');
        walk(join(parent, entry.name), path);
      } else {
        assert(entry.isFile(), 'package must contain regular files only');
        found.push(path);
      }
    }
  };
  walk(directory);
  return found.sort();
}

export function evidence(directory) {
  const expected = [...files, 'config.json'].sort();
  assert.deepEqual(packageFiles(directory), expected, 'package must contain the reviewed recursive file allowlist');
  return Object.fromEntries(expected.map(path => [path, hash(readFileSync(join(directory, path)))]));
}

function assemble() {
  checkManifest(manifest);
  const destination = packageRoot();
  mkdirSync(join(destination, 'ui'), { recursive: true });
  for (const path of files) {
    const input = path === 'plugin.wasm'
      ? join(source, 'target/wasm32-unknown-unknown/release/mtc_codex_expiring_reset.component.wasm')
      : path === 'LICENSE' ? join(root, path) : join(source, path);
    cpSync(input, join(destination, path));
  }
  writeFileSync(join(destination, 'config.json'), config);
  const wasm = readFileSync(join(destination, 'plugin.wasm'));
  assert.equal(wasm.subarray(0, 8).toString('hex'), '0061736d0d000100');
  const build = {
    format_version: 1,
    plugin_id: manifest.id,
    version: manifest.version,
    source_revision: process.env.GITHUB_SHA,
    files: evidence(destination),
    signed: false,
    host_acceptance: 'exact immutable host CI real SQLite/PostgreSQL background-action worker contracts',
  };
  assert.match(build.source_revision ?? '', /^[0-9a-f]{40}$/);
  writeFileSync(resolve('dist/codex-expiring-reset-build.json'), `${JSON.stringify(build, null, 2)}\n`);
}

export function requireReadyTrust(trust) {
  assert.equal(trust.format_version, 1);
  assert.equal(trust.status, 'ready', 'signing is disabled until new host and installer pins are reviewed');
  assert.equal(trust.host_repository, 'memeloop-online/memeloop-token-center');
  assert.equal(trust.installer_repository, 'ghcr.io/memeloop-online/memeloop-token-center-plugin-installer');
  assert.equal(trust.plugin_source, 'ghcr.io/memeloop-online/mtc-codex-expiring-reset');
  for (const key of ['host_source_revision', 'installer_source_revision', 'minimum_installer_contract_revision']) assert.match(trust[key] ?? '', /^[0-9a-f]{40}$/);
  for (const key of ['host_reference']) assert.match(trust[key] ?? '', /^ghcr\.io\/memeloop-online\/memeloop-token-center@sha256:[0-9a-f]{64}$/);
  assert.match(trust.installer_digest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.match(trust.cosign_version ?? '', /^v\d+\.\d+\.\d+-mtc\.\d+$/);
  assert.match(trust.host_verification_run ?? '', /^https:\/\/github\.com\/memeloop-online\/memeloop-token-center\/actions\/runs\/[0-9]+$/);
  assert.match(trust.installer_verification_run ?? '', /^https:\/\/github\.com\/memeloop-online\/memeloop-token-center\/actions\/runs\/[0-9]+$/);
  assert.equal(trust.installer_source_revision, trust.host_source_revision);
  assert.equal(trust.installer_verification_run, trust.host_verification_run);
  assert(Number.isSafeInteger(trust.host_release_artifact_id) && trust.host_release_artifact_id > 0);
  assert.match(trust.host_release_artifact_digest ?? '', /^sha256:[0-9a-f]{64}$/);
}

async function resolveTrust() {
  requireReadyTrust(trust);
  const token = process.env.GH_TOKEN;
  assert(token, 'official host and installer evidence verification token required');
  const get = async (repository, path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    assert(response.ok, `cannot verify pinned official release evidence (${response.status})`);
    return response.json();
  };
  const hostRun = await get(trust.host_repository, `actions/runs/${trust.host_verification_run.split('/').at(-1)}`);
  assert.equal(hostRun.conclusion, 'success');
  assert.equal(hostRun.head_sha, trust.host_source_revision);
  assert.equal(hostRun.path, '.github/workflows/ci.yml');
  assert.equal(hostRun.event, 'push');
  assert.equal(hostRun.head_branch, 'master');
  const installerRun = await get(trust.host_repository, `actions/runs/${trust.installer_verification_run.split('/').at(-1)}`);
  assert.equal(installerRun.conclusion, 'success');
  assert.equal(installerRun.head_sha, trust.installer_source_revision);
  assert.equal(installerRun.path, '.github/workflows/ci.yml');
  assert.equal(installerRun.event, 'push');
  assert.equal(installerRun.head_branch, 'master');
  const artifact = await get(trust.host_repository, `actions/artifacts/${trust.host_release_artifact_id}`);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.head_sha, trust.host_source_revision);
  assert.equal(artifact.workflow_run?.id, hostRun.id);
  assert.equal(artifact.name, `ghcr-release-${trust.host_source_revision}`);
  assert.equal(artifact.digest, trust.host_release_artifact_digest);
  appendFileSync(process.env.GITHUB_ENV, [
    `HOST_SOURCE_REVISION=${trust.host_source_revision}`,
    `HOST_REFERENCE=${trust.host_reference}`,
    `INSTALLER_SOURCE=${trust.installer_repository}`,
    `INSTALLER_DIGEST=${trust.installer_digest}`,
    `INSTALLER_SOURCE_REVISION=${trust.installer_source_revision}`,
    `MINIMUM_INSTALLER_CONTRACT_REVISION=${trust.minimum_installer_contract_revision}`,
    `COSIGN_VERSION=${trust.cosign_version}`,
    `OFFICIAL_HOST_RUN_ID=${hostRun.id}`,
  ].join('\n') + '\n');
}

function verifyOfficialImages() {
  requireReadyTrust(trust);
  const releases = json(join(process.env.RUNNER_TEMP, 'official-host-release/release-manifest.json'));
  assert(Array.isArray(releases));
  for (const [image, revision, reference] of [
    ['ghcr.io/memeloop-online/memeloop-token-center', trust.host_source_revision, trust.host_reference],
    [trust.installer_repository, trust.installer_source_revision, `${trust.installer_repository}@${trust.installer_digest}`],
  ]) {
    const entries = releases.filter(entry => entry.image === image);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].revision, revision);
    assert.equal(entries[0].reference, reference);
    assert.equal(`${image}@${entries[0].digest}`, reference);
  }
}

function select() {
  requireReadyTrust(trust);
  assert.equal(process.env.GITHUB_REPOSITORY, 'memeloop-online/memeloop-token-center-example-plugins');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
  assert.equal(process.env.GITHUB_REF_PROTECTED, 'true');
  checkManifest(manifest);
  const directory = packageRoot();
  const build = json(resolve('dist/codex-expiring-reset-build.json'));
  assert.equal(build.source_revision, process.env.GITHUB_SHA);
  assert.equal(build.plugin_id, manifest.id);
  assert.deepEqual(build.files, evidence(directory));
  const destination = join(process.env.RUNNER_TEMP, 'plugin-package');
  mkdirSync(join(destination, 'ui'), { recursive: true });
  for (const path of [...files, 'config.json']) cpSync(join(directory, path), join(destination, path));
  const identity = 'https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-codex-expiring-reset.yml@refs/heads/master';
  appendFileSync(process.env.GITHUB_ENV, [
    `PLUGIN_ID=${manifest.id}`, `PLUGIN_SOURCE=${trust.plugin_source}`,
    `SIGNING_IDENTITY=${identity}`, 'SIGNING_ISSUER=https://token.actions.githubusercontent.com',
  ].join('\n') + '\n');
}

function verifyRelease() {
  requireReadyTrust(trust);
  assert.equal(process.env.PLUGIN_ID, manifest.id);
  assert.equal(process.env.PLUGIN_SOURCE, trust.plugin_source);
  assert.equal(process.env.SIGNING_IDENTITY, 'https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-codex-expiring-reset.yml@refs/heads/master');
  assert.equal(process.env.SIGNING_ISSUER, 'https://token.actions.githubusercontent.com');
  assert.match(process.env.PLUGIN_DIGEST ?? '', /^sha256:[0-9a-f]{64}$/);
  const root = process.env.RUNNER_TEMP;
  const directory = join(root, 'plugin-package');
  const oci = json(join(root, 'plugin-oci-manifest.json'));
  assert.equal(hash(readFileSync(join(root, 'plugin-oci-manifest.json'))), process.env.PLUGIN_DIGEST);
  assert.equal(oci.schemaVersion, 2);
  assert.equal(oci.artifactType, 'application/vnd.memeloop.token-center.plugin.v1');
  assert.equal(oci.mediaType, 'application/vnd.oci.image.manifest.v1+json');
  assert.equal(oci.annotations?.['org.opencontainers.image.source'], 'https://github.com/memeloop-online/memeloop-token-center-example-plugins');
  assert.equal(oci.annotations?.['org.opencontainers.image.revision'], process.env.GITHUB_SHA);
  assert.equal(oci.config.mediaType, 'application/vnd.memeloop.token-center.plugin.config.v1+json');
  assert.equal(oci.config.digest, hash(config));
  assert.equal(oci.config.size, config.length);
  const build = json(resolve('dist/codex-expiring-reset-build.json'));
  assert.equal(build.source_revision, process.env.GITHUB_SHA);
  assert.deepEqual(build.files, evidence(directory));
  checkManifest(json(join(directory, 'plugin.json')));
  for (const path of files) {
    const layers = oci.layers.filter(layer => layer.annotations?.['org.opencontainers.image.title'] === path);
    assert.equal(layers.length, 1, `OCI entry ${path}`);
    const bytes = readFileSync(join(directory, path));
    assert.equal(layers[0].digest, hash(bytes));
    assert.equal(layers[0].size, bytes.length);
    assert.equal(layers[0].mediaType, path === 'plugin.json' ? 'application/vnd.memeloop.token-center.plugin.manifest.v1+json'
      : path === 'plugin.wasm' ? 'application/vnd.wasm.content.layer.v1+wasm' : 'application/vnd.memeloop.token-center.plugin.asset.v1');
    assert.equal(build.files[path], hash(bytes));
    const installed = readFileSync(join(root, `plugin-install/${manifest.id}/${path}`));
    assert.deepEqual(installed, bytes, `installed bytes ${path}`);
  }
  assert.equal(oci.layers.length, files.length);
  const signature = json(join(root, 'plugin-signature-verification.json'));
  assert(Array.isArray(signature) && signature.some(row => row.critical?.image?.['docker-manifest-digest'] === process.env.PLUGIN_DIGEST));
  const receipt = json(join(root, `plugin-install/${manifest.id}/.mtc-oci-install.json`));
  assert.equal(receipt.format_version, 1);
  assert.equal(receipt.signature_policy, 'cosign-keyless');
  assert.equal(receipt.source, trust.plugin_source);
  assert.equal(receipt.digest, process.env.PLUGIN_DIGEST);
  const installed = json(join(root, 'plugin-installation.json'));
  assert.equal(installed.id, manifest.id);
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.source, trust.plugin_source);
  assert.equal(installed.digest, process.env.PLUGIN_DIGEST);
  const release = {
    format_version: 1,
    plugin_id: manifest.id,
    version: manifest.version,
    reference: `${trust.plugin_source}@${process.env.PLUGIN_DIGEST}`,
    git_sha: process.env.GITHUB_SHA,
    workflow_run: `https://github.com/memeloop-online/memeloop-token-center-example-plugins/actions/runs/${process.env.GITHUB_RUN_ID}`,
    signature: { policy: 'cosign-keyless', issuer: 'https://token.actions.githubusercontent.com', identity: process.env.SIGNING_IDENTITY },
    installer_reference: `${trust.installer_repository}@${trust.installer_digest}`,
    installer_source_revision: trust.installer_source_revision,
    installer_verification_run: trust.installer_verification_run,
    host_reference: trust.host_reference,
    host_source_revision: trust.host_source_revision,
    files: files.map(path => ({ name: path, digest: hash(readFileSync(join(directory, path))) })),
    installation_verified: true,
    host_acceptance: build.host_acceptance,
  };
  writeFileSync(join(root, 'plugin-release.json'), `${JSON.stringify(release, null, 2)}\n`);
}

function publishDescriptor() {
  requireReadyTrust(trust);
  const env = process.env;
  assert.equal(env.GITHUB_REPOSITORY, 'memeloop-online/memeloop-token-center-example-plugins');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/master');
  assert.equal(env.GITHUB_REF_PROTECTED, 'true');
  const workflow = 'memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-codex-expiring-reset.yml@refs/heads/master';
  assert.equal(env.GITHUB_WORKFLOW_REF, workflow);
  assert.equal(env.SIGNING_IDENTITY, `https://github.com/${workflow}`);
  assert.equal(env.SIGNING_ISSUER, 'https://token.actions.githubusercontent.com');
  assert.equal(env.PLUGIN_SOURCE, trust.plugin_source);
  assert.equal(env.PLUGIN_ID, manifest.id);
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
  assert.match(env.PLUGIN_DIGEST ?? '', /^sha256:[0-9a-f]{64}$/);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/);
  verifyRelease();
  const reference = `${trust.plugin_source}@${env.PLUGIN_DIGEST}`;
  const path = join(env.RUNNER_TEMP, `${manifest.id}.json`);
  writeFileSync(path, `${JSON.stringify({ format_version: 1, reference, signer: { issuer: env.SIGNING_ISSUER, identity: env.SIGNING_IDENTITY } }, null, 2)}\n`);
  const tag = `${manifest.id}-${env.GITHUB_SHA}-run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  execFileSync('gh', ['release', 'create', tag, '--repo', env.GITHUB_REPOSITORY, '--target', env.GITHUB_SHA,
    '--title', `${manifest.id} (${env.GITHUB_SHA.slice(0, 12)})`, '--notes', `Installation descriptor for ${reference}.`, '--latest=false', path], { stdio: 'inherit' });
  appendFileSync(env.GITHUB_STEP_SUMMARY, `Installation URL: https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${tag}/${manifest.id}.json\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commands = { assemble, 'resolve-trust': resolveTrust, 'verify-official-images': verifyOfficialImages, select, 'verify-release': verifyRelease, 'publish-descriptor': publishDescriptor };
  assert(Object.hasOwn(commands, process.argv[2]), 'unknown Codex reset publication command');
  await commands[process.argv[2]]();
}
