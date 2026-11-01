import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// CI contract: presentation annotations must not change the persisted config shape.
const strategies = [
  ['plugin-sources/preferred-account', 'group_routing', { preferred_account_ids: [] }],
  ['plugin-sources/soonest-reset', 'group_routing', { target_provider: '', target_window_id: '' }],
  ['plugin-sources/model-guard', 'configuration', { blocked_models: [] }],
  ['examples/plugins/policy-rewrite', 'configuration', { enabled: false }],
];
function assertLabels(schema) {
  for (const key of ['title', 'description']) {
    assert.equal(typeof schema[key], 'string');
    assert(schema[key].trim().length > 0);
    for (const locale of ['zh-CN', 'en']) {
      assert.equal(typeof schema['x-i18n']?.[locale]?.[key], 'string');
      assert(schema['x-i18n'][locale][key].trim().length > 0);
    }
    assert.equal(schema['x-i18n'].en[key], schema[key]);
  }
}
for (const [directory, contribution, defaults] of strategies) {
  const manifest = JSON.parse(readFileSync(`${directory}/plugin.json`, 'utf8'));
  assert.equal(manifest.version, '1.0.1');
  const config = manifest.contributions[contribution];
  assert.deepEqual(config.default, defaults);
  assert.deepEqual(Object.keys(config.schema.properties).sort(), Object.keys(defaults).sort());
  assert.deepEqual([...config.schema.required].sort(), Object.keys(defaults).sort());
  assert.equal(config.schema.additionalProperties, false);
  assertLabels(config.schema);
  for (const [key, property] of Object.entries(config.schema.properties)) {
    assertLabels(property);
    if (key === 'preferred_account_ids') {
      assert.deepEqual(property['x-resource-selector'], { source: 'group-accounts', ordered: true });
      assert.equal(property.type, 'array');
      assert.equal(property.items.type, 'string');
      assert.equal(property.uniqueItems, true);
    } else {
      assert.equal(property['x-resource-selector'], undefined);
    }
  }
  if (directory.startsWith('plugin-sources/')) {
    const cargo = readFileSync(`${directory}/Cargo.toml`, 'utf8');
    const lock = readFileSync(`${directory}/Cargo.lock`, 'utf8');
    assert(cargo.includes(`name = "${manifest.id}"\nversion = "${manifest.version}"`));
    assert(lock.includes(`name = "${manifest.id}"\nversion = "${manifest.version}"`));
  }
}
console.log('Strategy schema presentation contracts verified.');
