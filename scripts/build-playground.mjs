import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist/playground');
const packageRoot = join(output, 'mtc-text-playground');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  assert.equal(result.status, 0, `${command} failed`);
}
rmSync(output, { recursive: true, force: true });
mkdirSync(join(packageRoot, 'ui'), { recursive: true });
run('npm', ['exec', '--yes', '--package=esbuild@0.25.12', '--', 'esbuild',
  'playground/ui/playground.mjs', '--bundle', '--format=esm', '--platform=browser',
  '--target=es2022', `--outfile=${join(packageRoot, 'ui/playground.mjs')}`,
  `--metafile=${join(output, 'bundle-metadata.json')}`, '--legal-comments=inline']);
const metadata = JSON.parse(readFileSync(join(output, 'bundle-metadata.json'), 'utf8'));
assert.equal(Object.keys(metadata.outputs).length, 1, 'ship a single browser module');
assert(Object.values(metadata.outputs).every(item => item.imports.length === 0), 'module must have no runtime imports');
for (const [source, destination] of [
  ['playground/plugin.json', 'plugin.json'], ['playground/README.md', 'README.md'],
  ['playground/THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['LICENSE', 'LICENSE'],
]) copyFileSync(join(root, source), join(packageRoot, destination));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'plugin.json'), 'utf8'));
assert.equal(manifest.id, 'mtc-text-playground');
assert.equal(manifest.wasm, null);
assert.deepEqual(manifest.contributions.operator_ui.map(item => item.component_id), ['workspace', 'open-model']);
run(process.execPath, ['--check', join(packageRoot, 'ui/playground.mjs')]);
const files = ['plugin.json', 'ui/playground.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const evidence = {
  plugin_id: manifest.id, version: manifest.version,
  source_revision: process.env.GITHUB_SHA ?? null,
  bundler: 'esbuild@0.25.12', module_sha256: `sha256:${sha256(join(packageRoot, 'ui/playground.mjs'))}`,
  memeloop_revision: '7e9aec265a8870ec45cd186112d65108fb6b606d',
  files: Object.fromEntries(files.map(name => [name, `sha256:${sha256(join(packageRoot, name))}`])),
};
writeFileSync(join(output, 'package-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const archive = `${manifest.id}-${manifest.version}.tar.gz`;
run('tar', ['-czf', join(output, archive), '-C', packageRoot, ...files]);
writeFileSync(join(output, 'SHA256SUMS'), `${sha256(join(output, archive))}  ${archive}\n`);
console.log(`Review package: dist/playground/${archive}`);
