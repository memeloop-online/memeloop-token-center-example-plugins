import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import {fetchPages,normalizeKeys,activateOperatorUi} from '../ui/playground.mjs';

test('activates with injected host bindings and registers both components',()=>{
 const pkg=activateOperatorUi({React,ReactDOM,ReactJSXRuntime,Fluent:{},defineOperatorUiPackage:x=>x});
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

test('publishes usable first-page results before a slow later page completes',async()=>{
 const first=Array.from({length:100},(_,i)=>({id:'r'+i,created_at:100-i}));
 let release;const later=new Promise(resolve=>{release=resolve;});const updates=[];
 const pending=fetchPages({requestApi:async({path})=>path.includes('before_id=')?later:first},'/internal/v1/model-routes?tenant_external_id=tenant-a',new AbortController().signal,'id',rows=>updates.push(rows));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(updates.length,1);assert.equal(updates[0].length,100);
 release([{id:'last',created_at:0}]);
 assert.equal((await pending).length,101);assert.equal(updates[0].length,100,'published snapshots remain stable');
});
test('cancelled transport response cannot publish a stale tenant page',async()=>{
 const ctrl=new AbortController();let release;const updates=[];
 const pending=fetchPages({requestApi:()=>new Promise(resolve=>{release=resolve;})},'/internal/v1/keys',ctrl.signal,'key_id',rows=>updates.push(rows));
 ctrl.abort();release([{key_id:'old-tenant',created_at:1}]);
 await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(updates,[]);
});
test('malformed list responses surface an actionable load failure',async()=>{
 await assert.rejects(fetchPages({requestApi:async()=>({unexpected:[]})},'/routes',new AbortController().signal),/Invalid list response/);
});
