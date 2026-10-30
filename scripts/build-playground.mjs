import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const runtimePath = join(output, 'runtime.cjs');
const modulePath = join(packageRoot, 'ui/playground.mjs');
const hostModules = ['react', 'react/jsx-runtime', 'react-dom'];
run('npm', ['exec', '--yes', '--package=esbuild@0.25.12', '--', 'esbuild',
  'playground/ui/playground.mjs', '--bundle', '--format=cjs', '--platform=browser',
  '--target=es2022', '--define:process.env.NODE_ENV="production"',
  ...hostModules.map(name => `--external:${name}`), `--outfile=${runtimePath}`,
  `--metafile=${join(output, 'bundle-metadata.json')}`, '--legal-comments=inline']);
const metadata = JSON.parse(readFileSync(join(output, 'bundle-metadata.json'), 'utf8'));
assert.equal(Object.keys(metadata.outputs).length, 1, 'ship a single browser module');
const bundledOutput = Object.values(metadata.outputs)[0];
for (const item of bundledOutput.imports) {
  assert(item.external && item.kind === 'require-call' && hostModules.includes(item.path),
    `only synchronous host bindings are allowed: ${item.path} (${item.kind})`);
}
const duplicatedHostLibraries = Object.keys(metadata.inputs).filter(path =>
  /(?:^|\/)node_modules\/(?:react(?:-dom)?(?:\/|$)|@fluentui\/)/.test(path));
assert.deepEqual(duplicatedHostLibraries, [], 'React and Fluent must come from the host component contract');
const runtime = readFileSync(runtimePath, 'utf8');
assert(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(runtime), 'browser module must execute without dynamic code evaluation');
// Every dependency evaluates synchronously after the host provides its React
// instance. The factory has local CommonJS bindings and never writes globals.
writeFileSync(modulePath, `export function activateOperatorUi(host) {
  const bindings = { react: host.React, 'react/jsx-runtime': host.ReactJSXRuntime, 'react-dom': host.ReactDOM };
  for (const [name, value] of Object.entries(bindings)) {
    if (!value) throw new Error('The operator UI host must provide ' + name + '.');
  }
  const module = { exports: {} };
  const require = name => {
    if (!Object.prototype.hasOwnProperty.call(bindings, name)) throw new Error('Unknown host module: ' + name);
    return bindings[name];
  };
  (function(module, exports, require) {
${runtime}
  })(module, module.exports, require);
  return module.exports.activateOperatorUi(host);
}
`);
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
const bundledPackages = new Map();
for (const [path, input] of Object.entries(bundledOutput.inputs)) {
  if (!input.bytesInOutput || !path.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, path));
  while (directory !== root && directory !== dirname(directory)) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const dependency = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (dependency.name && dependency.version) {
        const key = `${dependency.name}@${dependency.version}`;
        const entry = bundledPackages.get(key) ?? { directory, name: dependency.name, version: dependency.version,
          license: dependency.license ?? null, bytes_in_module: 0 };
        entry.bytes_in_module += input.bytesInOutput;
        bundledPackages.set(key, entry);
        break;
      }
    }
    directory = dirname(directory);
  }
}
let licenseAppendix = '\n\n# Licenses of npm packages contributing to the browser module\n';
const licenseEvidence = [];
for (const [key, entry] of [...bundledPackages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const licenseFiles = readdirSync(entry.directory).filter(name =>
    /^(?:(?:MIT[-.])?licen[cs]e|notice|copying|copyright(?:notice)?|unlicense)(?:[.-].*)?$/i.test(name)
    && statSync(join(entry.directory, name)).isFile()).sort();
  licenseAppendix += `\n## ${key}\n\nDeclared license: ${typeof entry.license === 'string' ? entry.license : JSON.stringify(entry.license)}.\n`;
  for (const name of licenseFiles) licenseAppendix += `\n### ${name}\n\n${readFileSync(join(entry.directory, name), 'utf8')}\n`;
  if (!licenseFiles.length) {
    assert.equal(entry.license, 'MIT', `${key} has no license file; review its distribution terms before packaging`);
    licenseAppendix += '\nThe npm distribution includes no separate license file. The declared MIT terms reproduced above apply.\n';
  }
  const { directory, ...evidence } = entry;
  licenseEvidence.push({ ...evidence, license_files: licenseFiles });
}
writeFileSync(join(packageRoot, 'THIRD_PARTY_NOTICES.md'), readFileSync(join(packageRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8') + licenseAppendix);
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
  module_bytes: statSync(modulePath).size,
  module_gzip_bytes: gzipSync(readFileSync(modulePath)).length,
  host_bindings: hostModules,
  npm_dependencies: npmDependencies,
  bundled_package_licenses: licenseEvidence,
  dependency_lock_sha256: `sha256:${sha256(join(root, 'playground/package-lock.json'))}`,
  memeloop_revision: '7e9aec265a8870ec45cd186112d65108fb6b606d',
  files: Object.fromEntries(files.map(name => [name, `sha256:${sha256(join(packageRoot, name))}`])),
};
writeFileSync(join(output, 'package-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const archive = `${manifest.id}-${manifest.version}.tar.gz`;
run('tar', ['-czf', join(output, archive), '-C', packageRoot, ...files]);
writeFileSync(join(output, 'SHA256SUMS'), `${sha256(join(output, archive))}  ${archive}\n`);
console.log(`Review package: dist/playground/${archive}`);
