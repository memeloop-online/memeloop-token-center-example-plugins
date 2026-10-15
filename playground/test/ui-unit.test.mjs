import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPages,normalizeKeys,activateOperatorUi} from '../ui/playground.mjs';

test('activates with injected host bindings and registers both components',()=>{
 const pkg=activateOperatorUi({React:{},Fluent:{},defineOperatorUiPackage:x=>x});
 assert.equal(typeof pkg.components.workspace,'function');
 assert.equal(typeof pkg.components['open-model'],'function');
});
test('route/key cursor follows created_at and stable key_id, deduplicates',async()=>{
 const page=Array.from({length:100},(_,i)=>({key_id:'k'+i,created_at:100-i}));
 const calls=[];
 const rows=await fetchPages({requestApi:async({path})=>{calls.push(path);return calls.length===1?page:[page[99],{key_id:'last',created_at:0}];}},'/internal/v1/keys',new AbortController().signal,'key_id');
 assert.equal(rows.length,101);
 assert.equal(calls[1],'/internal/v1/keys?limit=100&before_created_at=1&before_id=k99');
 assert.equal(normalizeKeys(rows)[100].id,'last');
});
test('repeated full page is an explicit pagination error',async()=>{
 const page=Array.from({length:100},(_,i)=>({id:String(i),created_at:i}));
 await assert.rejects(fetchPages({requestApi:async()=>page},'/routes',new AbortController().signal),/did not advance/);
});
test('inactive credentials cannot be selected',()=>{
 assert.deepEqual(normalizeKeys([{key_id:'good'},{key_id:'bad',status:'disabled'},{key_id:'off',enabled:false}]).map(k=>k.id),['good']);
});
