// Run only after signature verification and the official installer's clean install.
// The descriptor locates signed bytes; it grants no installation authority.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = 'memeloop-online/memeloop-token-center-example-plugins';
const workflows = {
  'mtc-health-intelligence': ['publish.yml', 'memeloop-token-center-health-intelligence-plugin'],
  'mtc-text-playground': ['publish-playground.yml', 'memeloop-token-center-text-playground-plugin'],
  'mtc-model-guard': ['publish-examples.yml', 'mtc-model-guard'],
  'mtc-preferred-account': ['publish-examples.yml', 'mtc-preferred-account'],
  'mtc-soonest-reset': ['publish-examples.yml', 'mtc-soonest-reset'],
  'google-antigravity': ['publish-examples.yml', 'mtc-google-antigravity'],
  'example-policy-rewrite': ['publish-examples.yml', 'mtc-example-policy-rewrite'],
};
const env = process.env;
assert.equal(env.GITHUB_REPOSITORY, repository);
assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(env.GITHUB_REF, 'refs/heads/master');
assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/);
assert(Object.hasOwn(workflows, env.PLUGIN_ID));
const [workflow, image] = workflows[env.PLUGIN_ID];
const identity = `https://github.com/${repository}/.github/workflows/${workflow}@refs/heads/master`;
const issuer = 'https://token.actions.githubusercontent.com';
assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/${workflow}@refs/heads/master`);
assert.equal(env.SIGNING_IDENTITY, identity);
assert.equal(env.SIGNING_ISSUER, issuer);
assert.equal(env.PLUGIN_SOURCE, `ghcr.io/memeloop-online/${image}`);
assert.match(env.PLUGIN_DIGEST ?? '', /^sha256:[0-9a-f]{64}$/);
const evidence = JSON.parse(readFileSync(join(env.RUNNER_TEMP, 'plugin-release.json'), 'utf8'));
const reference = `${env.PLUGIN_SOURCE}@${env.PLUGIN_DIGEST}`;
assert.equal(evidence.reference, reference);
assert.equal(evidence.plugin_id, env.PLUGIN_ID);
assert.equal(evidence.git_sha, env.GITHUB_SHA);
assert.equal(evidence.installation_verified, true);
assert.equal(evidence.signature.identity, identity);
assert.equal(evidence.signature.issuer, issuer);
const descriptor = { format_version: 1, reference, signer: { issuer, identity } };
const filename = `${env.PLUGIN_ID}.json`;
const path = join(env.RUNNER_TEMP, filename);
writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
// A new tag for every execution prevents replacing any existing asset or tag.
// Never use --clobber, --force, or update a mutable "latest" release.
const tag = `${env.PLUGIN_ID}-${env.GITHUB_SHA}-run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
execFileSync('gh', ['release', 'create', tag, '--repo', repository,
  '--target', env.GITHUB_SHA, '--title', `${env.PLUGIN_ID} (${env.GITHUB_SHA.slice(0, 12)})`,
  '--notes', `Installation descriptor for ${reference}. The host independently verifies source trust and the keyless signature.`,
  '--latest=false', path], { stdio: 'inherit' });
appendFileSync(env.GITHUB_ENV, `PLUGIN_RELEASE_TAG=${tag}\n`);
const url = `https://github.com/${repository}/releases/download/${tag}/${filename}`;
appendFileSync(env.GITHUB_STEP_SUMMARY, `\nInstallation URL: ${url}\n`);
