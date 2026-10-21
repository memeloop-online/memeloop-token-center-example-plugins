import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SnapshotService } from '../dist/server/server/fetcher.js';
const actual = JSON.parse(readFileSync('component-snapshot.json','utf8'));
const fixtureFetch = async (url) => {
  const source = JSON.parse(readFileSync('component/sources.json','utf8')).sources.find(s => s.endpoint === String(url) || s.robotsUrl === String(url));
  assert(source);
  return new Response(String(url).endsWith('robots.txt') ? 'User-agent: *\nAllow: /\n' : readFileSync('test/fixtures/'+source.source+'.json','utf8'));
};
const reference = await new SnapshotService({fetch:fixtureFetch,now:()=>new Date('2026-09-07T07:44:00Z')}).read();
for(let i=0;i<3;i++) {
  assert.equal(actual.sources[i].id,reference.sources[i].id);
  assert.deepEqual(actual.sources[i].rows,reference.sources[i].rows);
  assert.equal(actual.sources[i].sourceUpdatedAt,reference.sources[i].sourceUpdatedAt);
  assert.equal(actual.sources[i].fetchedAt,reference.sources[i].fetchedAt);
}
const bytes=readFileSync('plugin.wasm');
assert.equal(bytes.subarray(0,8).toString('hex'),'0061736d0d000100');
writeFileSync('component-build.json',JSON.stringify({sha:process.env.GITHUB_SHA,wasm_sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),size:bytes.length,host_revision:'48231e8409528d10072d2ca695ea4a2657dc17c7',actual_wasmtime:true,three_source_fixture_parity:true,bounds:JSON.parse(readFileSync('component-bounds.json','utf8'))},null,2)+'\n');
