import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// CI first compiles the reviewed WAT with the pinned wasm-tools. Exercise that
// real core module's canonical ABI here; the publication host fixture separately
// verifies the wrapped Component Model package in the actual MTC runtime.
const wasmPath = process.argv[2];
assert.ok(wasmPath, 'usage: node scripts/verify-policy-rewrite.mjs <core.wasm>');
const manifest = JSON.parse(await readFile(new URL('../examples/plugins/policy-rewrite/plugin.json', import.meta.url), 'utf8'));
assert.deepEqual(manifest.contributions.configuration, {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['enabled'],
    properties: {
      enabled: { type: 'boolean', title: 'Enable fixture request rewrite for this tenant' },
    },
  },
  default: { enabled: false },
});
const [provider] = manifest.contributions.providers;
assert.deepEqual(provider.protocols, ['openai']);
assert.deepEqual(provider.modalities, ['text']);
assert.ok(provider.config_schema.required.includes('development_fixture'));
assert.equal(provider.config_schema.properties.development_fixture.const, true);
assert.deepEqual(manifest.capabilities, []);

const unavailable = () => { throw new Error('fixture guest must not call a host capability'); };
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {
  'cm32p2|memeloop:token-center/host@0.2': {
    log: unavailable,
    'kv-get': unavailable,
    'kv-put': unavailable,
    'http-request': unavailable,
  },
});
const exports = instance.exports;
const memory = exports.cm32p2_memory;
const realloc = exports.cm32p2_realloc;
const postAuth = exports['cm32p2|memeloop:token-center/traffic-policy@0.2|post-auth'];
const prepare = exports['cm32p2|memeloop:token-center/upstream-provider@0.2|prepare'];
const normalize = exports['cm32p2|memeloop:token-center/upstream-provider@0.2|normalize'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const checks = [];

function string(value) {
  const bytes = encoder.encode(value);
  const pointer = realloc(0, 0, 1, bytes.length);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
  return [pointer, bytes.length];
}

// Exercise allocation mechanics independently of policy decisions. These are
// CI-only checks against the freshly compiled core, never a replacement for
// the real Component Model host fixture below.
const preserved = string('allocator-preserves-old-bytes');
const resized = realloc(preserved[0], preserved[1], 64, 70000);
assert.equal(resized % 64, 0);
assert.equal(readString(resized, preserved[1]), 'allocator-preserves-old-bytes');
assert.ok(memory.buffer.byteLength > 65536, 'realloc must grow across a page');
const shrunk = realloc(resized, 70000, 16, 9);
assert.equal(readString(shrunk, 9), 'allocator');
assert.equal(realloc(shrunk, 9, 1, 0), 0);
for (const [alignment, length] of [[0, 1], [3, 1], [1, 0xffffffff], [0x80000000, 1]]) {
  assert.throws(() => realloc(0, 0, alignment, length), WebAssembly.RuntimeError);
}
assert.throws(() => realloc(0xfffffff0, 64, 1, 128), WebAssembly.RuntimeError);
checks.push('allocator-growth-alignment-copy-free-overflow');

function readString(pointer, length) {
  return decoder.decode(new Uint8Array(memory.buffer, pointer, length));
}

function context(config) {
  // Six WIT string fields, each lowered to pointer/length. Put a conflicting
  // opt-in in request-json below to detect accidental reads from slots 12/13.
  return ['tenant-fixture', 'principal-fixture', 'key-fixture', 'openai', 'original-model', config].flatMap(string);
}

function decision(config, request = '{"model":"original-model","enabled":true}') {
  const pointer = postAuth(...context(config), ...string(request));
  const data = new DataView(memory.buffer);
  assert.equal(data.getUint32(pointer, true), 0, 'post-auth result must be Ok');
  const option = (offset) => {
    const tag = data.getUint8(pointer + offset);
    assert.ok(tag === 0 || tag === 1);
    return tag === 0 ? null : readString(data.getUint32(pointer + offset + 4, true), data.getUint32(pointer + offset + 8, true));
  };
  return {
    allow: data.getUint8(pointer + 4) === 1,
    reason: option(8),
    model: option(20),
    account: option(32),
    request: option(44),
  };
}

function passThrough(config, name) {
  assert.deepEqual(decision(config), { allow: true, reason: null, model: null, account: null, request: null }, name);
  checks.push(name);
}

passThrough(JSON.stringify(manifest.contributions.configuration.default), 'manifest-default-pass-through');
passThrough('{"enabled":false}', 'explicit-false-pass-through');
for (const size of [64 * 1024, 256 * 1024, 1024 * 1024]) {
  const request = JSON.stringify({ model: 'original-model', input: '\u0000"\\'.repeat(Math.ceil(size / 3)) });
  assert.ok(encoder.encode(request).length >= size);
  assert.deepEqual(decision('{"enabled":false}', request), {
    allow: true, reason: null, model: null, account: null, request: null,
  }, `disabled large escaped request ${size}`);
  const enabled = decision('{"enabled":true}', request);
  assert.equal(enabled.allow, true);
  assert.equal(enabled.model, 'example-rewritten');
  checks.push(`large-escaped-request-${size}-disabled-and-enabled`);
}
const rewritten = decision('{"enabled":true}', '{"model":"original-model","enabled":false}');
assert.deepEqual(rewritten, {
  allow: true,
  reason: null,
  model: 'example-rewritten',
  account: null,
  request: '{"model":"example-rewritten","messages":[{"role":"user","content":"rewritten by plugin"}]}',
});
checks.push('exact-true-config-slots-10-11-rewrite');
// Reuse the instance after an enabled call to detect stale option tags.
passThrough('{"enabled":false}', 'true-then-false-clears-rewrite');
for (const [name, config] of [
  ['missing-field', '{}'],
  ['empty-config', ''],
  ['spaced-json', '{"enabled": true}'],
  ['trailing-whitespace', '{"enabled":true} '],
  ['extra-field', '{"enabled":true,"extra":true}'],
  ['string-boolean', '{"enabled":"true"}'],
  ['numeric-boolean', '{"enabled":1}'],
  ['nested-field', '{"nested":{"enabled":true}}'],
  ['wrong-case', '{"Enabled":true}'],
  ['same-length-invalid-json', '{"enabled":truE}'],
]) {
  passThrough(config, `direct-abi-${name}-disabled`);
}

function stringResult(pointer) {
  const data = new DataView(memory.buffer);
  return {
    tag: data.getUint32(pointer, true),
    value: readString(data.getUint32(pointer + 4, true), data.getUint32(pointer + 8, true)),
  };
}

const prepared = stringResult(prepare(
  ...context('{"enabled":false}'),
  ...string('{"base_url":"https://fixture.invalid","development_fixture":true}'),
  ...string('{"model":"example-rewritten"}'),
));
assert.equal(prepared.tag, 0);
const preparedEnvelope = JSON.parse(prepared.value);
assert.equal(preparedEnvelope.method, 'POST');
assert.equal(preparedEnvelope.path, '/vendor/infer');
assert.equal(preparedEnvelope.streaming, false);
assert.deepEqual(preparedEnvelope.headers, { 'content-type': 'application/json', 'x-plugin-shape': 'buffered-v1' });
assert.deepEqual(JSON.parse(Buffer.from(preparedEnvelope.body_base64, 'base64').toString()), { prompt: 'from-component', model: 'vendor-model' });
checks.push('fixed-credential-free-prepare');

// Match the host's Serialize struct field order, rather than an arbitrary map.
const upstreamEnvelope = (status) => JSON.stringify({ status, headers: { 'content-type': 'application/json' }, body_base64: 'e30=' });
const normalized = stringResult(normalize(...context('{}'), ...string(upstreamEnvelope(200))));
assert.equal(normalized.tag, 0);
const normalizedEnvelope = JSON.parse(normalized.value);
assert.equal(normalizedEnvelope.status, 200);
assert.deepEqual(normalizedEnvelope.usage, { input_tokens: 7, output_tokens: 3, estimated: false });
const chat = JSON.parse(Buffer.from(normalizedEnvelope.body_base64, 'base64').toString());
assert.equal(chat.object, 'chat.completion');
assert.equal(chat.choices[0].message.content, 'normalized by component');
checks.push('canonical-200-fixture-normalize');
for (const status of [201, 204, 301, 302, 307, 400, 401, 403, 429, 500, 503]) {
  const result = stringResult(normalize(...context('{}'), ...string(upstreamEnvelope(status))));
  assert.deepEqual(result, { tag: 1, value: 'fixture expected HTTP 200' }, `upstream ${status} must not normalize to success`);
  checks.push(`normalize-${status}-rejected`);
}
for (const response of ['', '{}', '[]', '{"status":2000,"headers":{},"body_base64":""}', '{ "status":200,"headers":{},"body_base64":""}']) {
  assert.equal(stringResult(normalize(...context('{}'), ...string(response))).tag, 1);
}
checks.push('unrecognized-envelope-rejected');
// A later successful call must replace the previous Err discriminant.
assert.equal(stringResult(normalize(...context('{}'), ...string(upstreamEnvelope(200)))).tag, 0);
checks.push('normalize-error-then-success');

console.log(JSON.stringify({ status: 'passed', package: manifest.id, core_wasm: wasmPath, check_count: checks.length, checks }));
