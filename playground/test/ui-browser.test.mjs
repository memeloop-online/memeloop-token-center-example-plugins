// CI-only acceptance: real React, Fluent Dialog, bundled plugin, and Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const fixture=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as Fluent from '@fluentui/react-components';
import {activateOperatorUi} from './dist/playground/mtc-text-playground/ui/playground.mjs';
const pkg=activateOperatorUi({React,Fluent,defineOperatorUiPackage:x=>x});
const route={id:'route-1',public_model:'text-model',upstream_model:'upstream',enabled:true,protocol:'openai',created_at:1};
window.requests=[];window.responses=[];window.navigations=[];let iteration=0;
const mode=new URLSearchParams(location.search).get('mode');
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const api={navigate:(...args)=>window.navigations.push(args),discoverApi:async()=>({paths:{'/internal/v1/widgets':{post:{}}}}),requestApi:async req=>{
 window.requests.push(req);
 if(req.path.includes('model-routes')){if(mode==='403')throw Object.assign(new Error('Forbidden'),{status:403});return [route];}
 if(req.path.startsWith('/internal/v1/keys'))return [{key_id:'key-1',alias:'Billing',created_at:1}];
 if(req.path==='/internal/v1/widgets')return {ok:true};
 if(req.path==='/internal/v1/inference/chat/completions'){
  if(mode==='pending')return new Promise(()=>{});
  iteration++;
  const message=mode==='mutation'&&iteration===1?{role:'assistant',content:'Review change',tool_calls:[call('docs','discover_api',{}),call('write','request_api',{method:'POST',path:'/internal/v1/widgets',body:{name:'example'}})]}:{role:'assistant',content:'Hello from model'};
  const response={choices:[{message}]};window.responses.push(response);return response;
 }
 throw new Error('Unexpected path '+req.path);
}};
const view=createRoot(document.getElementById('root'));window.unmount=()=>view.unmount();
view.render(React.createElement(Fluent.FluentProvider,{theme:Fluent.webLightTheme},React.createElement(pkg.components.workspace,{api,tenantExternalId:'tenant-a',locale:'en',context:{}}),React.createElement(pkg.components['open-model'],{api,context:{modelRoute:route},locale:'en'})));
`;

test('actual plugin mounts, sends, reviews, stops and navigates in Chromium',{timeout:120000},async()=>{
 const output=await build({stdin:{contents:fixture,resolveDir:root,loader:'js'},bundle:true,write:false,format:'esm',platform:'browser'});
 const js=output.outputFiles[0].text;
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?js:'<!doctype html><html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser,page;
 const errors=[];
 const artifactDir=root+'dist/playground-browser';
 mkdirSync(artifactDir,{recursive:true});
 try{
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:390,height:844}});
  page.on('pageerror',error=>errors.push(error.message));
  const url='http://127.0.0.1:'+server.address().port;
  const choose=async()=>{await page.locator('#mtp-model').selectOption('route-1');await page.locator('#mtp-key').selectOption('key-1');};
  const send=async()=>{await page.getByRole('textbox',{name:'Type a message',exact:true}).fill('Inspect workspace');await page.getByRole('button',{name:'Send',exact:true}).click();};
  await page.goto(url);await choose();await send();
  await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
  await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.responses.at(-1)?.choices[0]?.message.content),'Hello from model');
  assert.equal(await page.getByText('An error occurred:',{exact:false}).count(),0);
  mkdirSync(root+'dist/playground-browser',{recursive:true});
  await page.screenshot({path:root+'dist/playground-browser/mobile-chat.png',fullPage:true});
  assert.equal(await page.evaluate(()=>window.requests.find(r=>r.body?.key_id)?.body.key_id),'key-1');
  await page.getByRole('button',{name:'Open in Playground'}).click();
  assert.equal(await page.evaluate(()=>window.navigations[0][1].modelRoute.public_model),'text-model');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const approval of ['Cancel','Approve']){
   await page.goto(url+'?mode=mutation');await choose();await send();
   const dialog=page.getByRole('dialog');await dialog.waitFor();
   if(approval==='Cancel')await page.screenshot({path:root+'dist/playground-browser/mutation-review.png',fullPage:true});
   await page.waitForFunction(()=>document.querySelector('[role=dialog]')?.contains(document.activeElement));
   assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
   await page.keyboard.press('Tab');
   assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
   await dialog.getByRole('button',{name:approval,exact:true}).click();
   await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
   await page.getByText('Done · Iterations:',{exact:false}).waitFor();
   assert.equal(await page.evaluate(()=>window.responses.at(-1)?.choices[0]?.message.content),'Hello from model');
   assert.equal(await page.getByText('An error occurred:',{exact:false}).count(),0);
   assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path==='/internal/v1/widgets').length),approval==='Approve'?1:0);
  }
  await page.goto(url+'?mode=pending');await choose();await send();
  assert.equal(await page.locator('#mtp-key').isDisabled(),true);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByText('Stopped. The upstream request may still continue and incur cost.',{exact:true}).waitFor();
  await page.evaluate(()=>window.unmount());
  await page.goto(url+'?mode=403');await page.getByText('Missing read permission (keys:read required). Contact your administrator.',{exact:false}).waitFor();
  assert.deepEqual(errors,[]);
 }catch(error){
  if(page){
   await page.screenshot({path:artifactDir+'/failure.png',fullPage:true}).catch(()=>{});
   const diagnostic=await page.evaluate(()=>({
    // The page only runs the deterministic mock above. Record summaries, never raw bodies.
    mode:new URLSearchParams(location.search).get('mode'),
    requests:(window.requests||[]).map(r=>({path:r.path,method:r.method||'GET',model:r.body?.request?.model,keyId:r.body?.key_id})),
    assistantResponses:(window.responses||[]).map(r=>r.choices?.[0]?.message?.content),
    transcript:document.querySelector('[role=log]')?.innerText,
    alerts:[...document.querySelectorAll('[role=alert]')].map(el=>el.innerText),
    text:document.body.innerText.slice(0,8000),
    selectedModel:document.querySelector('#mtp-model')?.value,
    selectedKey:document.querySelector('#mtp-key')?.value
   })).catch(()=>({pageUnavailable:true}));
   writeFileSync(artifactDir+'/failure.json',JSON.stringify({...diagnostic,pageErrors:errors,failure:String(error)},null,2));
  }
  throw error;
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
