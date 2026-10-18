import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

const repository = 'memeloop-online/memeloop-token-center-example-plugins';
const cases = [
  ['mtc-health-intelligence', 'publish.yml', 'memeloop-token-center-health-intelligence-plugin'],
  ['mtc-text-playground', 'publish-playground.yml', 'memeloop-token-center-text-playground-plugin'],
  ['mtc-model-guard', 'publish-examples.yml', 'memeloop-token-center-example-model-guard'],
  ['mtc-preferred-account', 'publish-examples.yml', 'memeloop-token-center-example-preferred-account'],
  ['mtc-soonest-reset', 'publish-examples.yml', 'mtc-soonest-reset'],
  ['google-antigravity', 'publish-examples.yml', 'mtc-google-antigravity'],
  ['example-policy-rewrite', 'publish-examples.yml', 'mtc-example-policy-rewrite'],
];
const publisher = resolve('scripts/publish-release-descriptor.mjs');
function fixture(item, change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'mtc-release-descriptor-'));
  const [id, workflow, image] = item;
  const identity = `https://github.com/${repository}/.github/workflows/${workflow}@refs/heads/master`;
  const issuer = 'https://token.actions.githubusercontent.com';
  const source = `ghcr.io/memeloop-online/${image}`;
  const digest = `sha256:${'a'.repeat(64)}`;
  const revision = 'b'.repeat(40);
  const evidence = { reference: `${source}@${digest}`, plugin_id: id, git_sha: revision,
    installation_verified: true, signature: { identity, issuer } };
  const env = { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/master', GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: revision, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/${workflow}@refs/heads/master`,
    SIGNING_IDENTITY: identity, SIGNING_ISSUER: issuer, PLUGIN_ID: id, PLUGIN_SOURCE: source,
    PLUGIN_DIGEST: digest, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, 'summary'),
    GITHUB_ENV: join(root, 'env'), PATH: `${root}${delimiter}${process.env.PATH}` };
  // Only record CLI arguments; these tests have no network or publication authority.
  writeFileSync(join(root, 'gh'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.RUNNER_TEMP + "/args", JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  change(env, evidence);
  writeFileSync(join(root, 'plugin-release.json'), JSON.stringify(evidence));
  const result = spawnSync(process.execPath, [publisher], { env, encoding: 'utf8' });
  return { root, result, identity, issuer, reference: `${source}@${digest}`, revision, id };
}
for (const item of cases) test(`publishes exact download descriptor for ${item[0]}`, () => {
  const value = fixture(item);
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(value.root, `${value.id}.json`))), {
      format_version: 1, reference: value.reference, signer: { issuer: value.issuer, identity: value.identity },
    });
    const args = JSON.parse(readFileSync(join(value.root, 'args')));
    assert.deepEqual(args.slice(0, 3), ['release', 'create', `${value.id}-${value.revision}-run-123-2`]);
    assert(args.includes('--latest=false'));
    assert(!args.includes('--clobber'));
    assert(readFileSync(join(value.root, 'summary'), 'utf8').includes(`/releases/download/${args[2]}/${value.id}.json`));
  } finally { rmSync(value.root, { recursive: true }); }
});
for (const [name, change] of [
  ['unverified install', (_, evidence) => { evidence.installation_verified = false; }],
  ['different digest', (_, evidence) => { evidence.reference += '0'; }],
  ['old repository identity', (env) => { env.SIGNING_IDENTITY = env.SIGNING_IDENTITY.replace('example-plugins', 'health-intelligence-plugin'); }],
  ['wrong workflow', (env) => { env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/other.yml@refs/heads/master`; }],
  ['pull request execution', (env) => { env.GITHUB_EVENT_NAME = 'pull_request'; }],
  ['unprotected master', (env) => { env.GITHUB_REF_PROTECTED = 'false'; }],
  ['non-master execution', (env) => { env.GITHUB_REF = 'refs/heads/feature'; }],
]) test(`rejects ${name} before invoking GitHub`, () => {
  const value = fixture(cases[0], change);
  try {
    assert.notEqual(value.result.status, 0);
    assert.throws(() => readFileSync(join(value.root, 'args')), { code: 'ENOENT' });
  } finally { rmSync(value.root, { recursive: true }); }
});
