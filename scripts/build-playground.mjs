import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

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
const duplicatedHostLibraries = Object.keys(metadata.inputs).filter(path =>
  /(?:^|\/)node_modules\/(?:react(?:-dom)?(?:\/|$)|@fluentui\/)/.test(path));
assert.deepEqual(duplicatedHostLibraries, [], 'React and Fluent must come from the host component contract');
const bundledUiFrameworks = Object.entries(Object.values(metadata.outputs)[0].inputs).filter(([path, input]) =>
  input.bytesInOutput > 0 && /(?:^|\/)node_modules\/(?:@mui|@assistant-ui)\//.test(path));
assert.deepEqual(bundledUiFrameworks, [], 'MemeLoop headless display helpers must not include a second UI framework');
const bundledOutput = Object.values(metadata.outputs)[0];
const dependencyManifest = JSON.parse(readFileSync(join(root, 'playground/package.json'), 'utf8'));
const npmDependencies = Object.fromEntries(Object.entries(dependencyManifest.dependencies).map(([name, version]) => {
  const installed = JSON.parse(readFileSync(join(root, 'playground/node_modules', name, 'package.json'), 'utf8'));
  assert.equal(installed.version, version, `${name} must match the pinned playground dependency`);
  const inputs = Object.entries(bundledOutput.inputs).filter(([path]) => path.includes(`/node_modules/${name}/`));
  assert(inputs.some(([, input]) => input.bytesInOutput > 0), `${name} must contribute actual functionality to the bundle`);
  return [name, { version, bytes_in_module: inputs.reduce((sum, [, input]) => sum + input.bytesInOutput, 0) }];
}));
for (const [source, destination] of [
  ['playground/plugin.json', 'plugin.json'], ['playground/README.md', 'README.md'],
  ['playground/THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['LICENSE', 'LICENSE'],
]) copyFileSync(join(root, source), join(packageRoot, destination));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'plugin.json'), 'utf8'));
assert.equal(manifest.id, 'mtc-text-playground');
assert.equal(manifest.version, '1.1.0');
assert.equal(manifest.wasm, null);
assert.deepEqual(manifest.contributions.operator_ui.map(item => item.component_id), ['workspace', 'open-model']);
run(process.execPath, ['--check', join(packageRoot, 'ui/playground.mjs')]);
const files = ['plugin.json', 'ui/playground.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const evidence = {
  plugin_id: manifest.id, version: manifest.version,
  source_revision: process.env.GITHUB_SHA ?? null,
  bundler: 'esbuild@0.25.12', module_sha256: `sha256:${sha256(join(packageRoot, 'ui/playground.mjs'))}`,
  module_bytes: bundledOutput.bytes,
  module_gzip_bytes: gzipSync(readFileSync(join(packageRoot, 'ui/playground.mjs'))).length,
  npm_dependencies: npmDependencies,
  dependency_lock_sha256: `sha256:${sha256(join(root, 'playground/package-lock.json'))}`,
  memeloop_revision: '7e9aec265a8870ec45cd186112d65108fb6b606d',
  files: Object.fromEntries(files.map(name => [name, `sha256:${sha256(join(packageRoot, name))}`])),
};
writeFileSync(join(output, 'package-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const archive = `${manifest.id}-${manifest.version}.tar.gz`;
run('tar', ['-czf', join(output, archive), '-C', packageRoot, ...files]);
writeFileSync(join(output, 'SHA256SUMS'), `${sha256(join(output, archive))}  ${archive}\n`);
console.log(`Review package: dist/playground/${archive}`);
