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
import * as ReactDOM from 'react-dom';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import * as Fluent from '@fluentui/react-components';
import {activateOperatorUi} from './dist/playground/mtc-text-playground/ui/playground.mjs';
const pkg=activateOperatorUi({React,ReactDOM,ReactJSXRuntime,Fluent,defineOperatorUiPackage:x=>x});
const route={id:'route-1',public_model:'text-model',upstream_model:'upstream',enabled:true,protocol:'openai',route_group_ids:['general'],created_at:1};
const anthropicRoute={...route,id:'route-2',public_model:'anthropic-model',protocol:'anthropic'};
window.requests=[];window.responses=[];window.navigations=[];let iteration=0;let routeLoads=0;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwajjwHwAEzAJy+GEfCwAAAABJRU5ErkJggg==';
// A valid ancillary PNG chunk makes distinct, decodable images large enough
// to exercise the attachment batch budget without changing their tiny pixels.
const paddedPng=marker=>{
 const original=Uint8Array.from(atob(png),character=>character.charCodeAt(0));
 const bytes=new Uint8Array(9*1024*1024);const offset=original.length-12;
 bytes.set(original.subarray(0,offset));
 const length=bytes.length-original.length-12;const view=new DataView(bytes.buffer);
 view.setUint32(offset,length);bytes.set([110,112,65,100],offset+4);
 bytes.fill(marker,offset+8,offset+8+length);
 let crc=0xffffffff;
 for(let index=offset+4;index<offset+8+length;index++){
  crc^=bytes[index];for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
 }
 view.setUint32(offset+8+length,(crc^0xffffffff)>>>0);
 bytes.set(original.subarray(offset),bytes.length-12);
 let binary='';for(let index=0;index<bytes.length;index+=32768)binary+=String.fromCharCode(...bytes.subarray(index,index+32768));
 return btoa(binary);
};
const mode=new URLSearchParams(location.search).get('mode');
const longMessage='Full assistant response start. '+('Detailed product analysis. '.repeat(2400))+' ORIGINAL_RESPONSE_END';
if(mode==='multi-group')route.route_group_ids=['general','featured'];
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const api={navigate:(...args)=>window.navigations.push(args),discoverApi:async()=>({paths:{'/internal/v1/widgets':{post:{}}}}),requestApi:async req=>{
 window.requests.push(req);
 if(req.path.includes('model-routes')){
  routeLoads++;if(mode==='403')throw Object.assign(new Error('Forbidden'),{status:403});
  if(mode==='retry'&&routeLoads===1)throw new Error('Route service temporarily unavailable');
  if(mode==='progressive'){
   if(req.path.includes('before_id='))return new Promise(resolve=>{window.releaseRoutes=()=>resolve([{...anthropicRoute,created_at:0}]);});
   return Array.from({length:100},(_,i)=>({...route,id:i?'filler-'+i:route.id,public_model:i?'model-'+i:route.public_model,created_at:100-i}));
  }
  return [route,anthropicRoute];
 }
 if(req.path.startsWith('/internal/v1/route-groups'))return [{id:'general',name:'General purpose'},{id:'featured',name:'Featured models'}];
 if(req.path.startsWith('/internal/v1/filter-assistant/settings'))return {billing_key_id:mode==='late-key'?'key-late':'key-1',model_route_id:'route-1'};
 if(req.path.startsWith('/internal/v1/keys')){
  if(mode==='late-key'){
   if(req.path.includes('before_id='))return new Promise(resolve=>{window.releaseKeys=()=>resolve([{key_id:'key-late',alias:'Configured billing',created_at:0}]);});
   return Array.from({length:100},(_,i)=>({key_id:i?'key-'+(i+1):'key-1',alias:i?'Key '+i:'Billing',created_at:100-i}));
  }
  return [{key_id:'key-1',alias:'Billing',created_at:1},{key_id:'key-2',alias:'Second billing',created_at:0}];
 }
 if(req.path==='/internal/v1/inference/responses'){
  const results=mode==='duplicate-images'?[png,png]:mode==='budget-images'?[paddedPng(1),paddedPng(2)]:[png];
  const response={id:'response-image',status:mode==='partial-image'?'in_progress':'completed',output:results.map(result=>({type:'image_generation_call',status:'completed',result}))};window.responses.push(response);return response;
 }
 if(req.path==='/internal/v1/widgets')return {ok:true};
 if(req.path==='/internal/v1/inference/messages'){
  const response={id:'anthropic-response',type:'message',role:'assistant',content:[{type:'text',text:'Hello from Anthropic'}],stop_reason:'end_turn'};window.responses.push(response);return response;
 }
 if(req.path==='/internal/v1/inference/chat/completions'){
  if(mode==='pending')return new Promise(()=>{});
  iteration++;
  const message=mode==='mutation'&&iteration===1?{role:'assistant',content:'Review change',tool_calls:[call('docs','discover_api',{}),call('write','request_api',{method:'POST',path:'/internal/v1/widgets',body:{name:'example'}})]}:{role:'assistant',content:mode==='long-message'&&iteration===1?longMessage:'Hello from model'};
  const response={choices:[{message}]};window.responses.push(response);return response;
 }
 throw new Error('Unexpected path '+req.path);
}};
const view=createRoot(document.getElementById('root'));window.unmount=()=>view.unmount();
const render=(tenantExternalId='tenant-a')=>view.render(React.createElement(Fluent.FluentProvider,{theme:Fluent.webLightTheme},React.createElement(pkg.components.workspace,{api,tenantExternalId,locale:'en',context:{}}),React.createElement(pkg.components['open-model'],{api,context:{modelRoute:mode==='anthropic'?anthropicRoute:route},locale:'en'})));window.changeTenant=()=>render('tenant-b');render();
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
  page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  const url='http://127.0.0.1:'+server.address().port;
  const chooseModel=async(label='text-model · openai')=>{await page.getByRole('combobox',{name:'Model',exact:true}).click();await page.getByRole('option',{name:label,exact:true}).click();};
  const choose=async()=>{await chooseModel();await page.locator('#mtp-key').selectOption('key-1');};
  const send=async()=>{await page.getByRole('textbox',{name:'Type a message',exact:true}).fill('Inspect workspace');await page.getByRole('button',{name:'Send',exact:true}).click();};
  await page.goto(url);await choose();await send();
  await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
  await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.responses.at(-1)?.choices[0]?.message.content),'Hello from model');
  assert.equal(await page.getByText('An error occurred:',{exact:false}).count(),0);
  mkdirSync(root+'dist/playground-browser',{recursive:true});
  await page.screenshot({path:root+'dist/playground-browser/mobile-chat.png',fullPage:true,animations:'disabled'});
  assert.equal(await page.evaluate(()=>window.requests.find(r=>r.body?.key_id)?.body.key_id),'key-1');
  await page.getByRole('button',{name:'Open in Playground'}).click();
  assert.equal(await page.evaluate(()=>window.navigations[0][1].modelRoute.public_model),'text-model');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.evaluate(()=>Array.isArray(window.requests.find(r=>r.body?.request)?.body.request.tools)),true);
  await page.goto(url+'?mode=no-tools');await choose();
  await page.getByRole('checkbox',{name:'Allow assistant product tools',exact:true}).uncheck();await send();
  await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
  await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>Object.hasOwn(window.requests.find(r=>r.body?.request).body.request,'tools')),false);
  await page.goto(url+'?mode=anthropic');
  await chooseModel('anthropic-model · anthropic');await page.locator('#mtp-key').selectOption('key-1');
  await page.getByRole('checkbox',{name:'Allow assistant product tools',exact:true}).uncheck();await send();
  await page.getByRole('log').filter({hasText:'Hello from Anthropic'}).waitFor();
  await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  assert.deepEqual(await page.evaluate(()=>{const req=window.requests.find(r=>r.body?.request);return {path:req.path,model:req.body.request.model,hasTools:Object.hasOwn(req.body.request,'tools')};}),{path:'/internal/v1/inference/messages',model:'anthropic-model',hasTools:false});
  await page.getByRole('button',{name:'Open in Playground'}).click();
  assert.equal(await page.evaluate(()=>window.navigations[0][1].modelRoute.protocol),'anthropic');

  // Search and selection share one accessible, grouped control.
  await page.goto(url);await page.getByRole('combobox',{name:'Model',exact:true}).fill('General purpose');
  await page.getByRole('option',{name:'text-model · openai',exact:true}).waitFor();
  assert.equal(await page.getByRole('group',{name:'General purpose',exact:true}).count(),1);
  assert.equal(await page.getByRole('textbox',{name:'Search models',exact:true}).count(),0);
  await page.getByRole('option',{name:'text-model · openai',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#mtp-key')?.value==='key-1');
  assert.equal(await page.getByRole('checkbox',{name:'Allow assistant product tools',exact:true}).getAttribute('aria-describedby')!==null,true);
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path.includes('/route-groups')).every(r=>!new URL(r.path,location.origin).searchParams.has('limit'))),true);

  // The same route can be selected from either membership, including with a keyboard.
  await page.goto(url+'?mode=multi-group');
  const modelSearch=page.getByRole('combobox',{name:'Model',exact:true});
  await modelSearch.fill('Featured models');
  const featured=page.getByRole('group',{name:'Featured models',exact:true});
  await featured.getByRole('option',{name:'text-model · openai',exact:true}).waitFor();
  await featured.getByRole('option',{name:'text-model · openai',exact:true}).click();
  assert.equal(await modelSearch.inputValue(),'text-model');
  await modelSearch.fill('Featured models');
  await featured.getByRole('option',{name:'text-model · openai',exact:true}).waitFor();
  await modelSearch.press('ArrowDown');await modelSearch.press('Enter');
  assert.equal(await modelSearch.inputValue(),'text-model');
  assert.equal(await modelSearch.getAttribute('aria-expanded'),'false');
  await send();await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.find(r=>r.body?.request).body.request.model),'text-model');

  // Official chat display bounds affect rendering only, even after expand/collapse.
  await page.goto(url+'?mode=long-message');await choose();await send();
  const expand=page.getByRole('button',{name:'Show full message',exact:true});await expand.waitFor();
  const original=await page.evaluate(()=>window.responses[0].choices[0].message.content);
  const transcript=page.getByRole('log');
  const projection=await transcript.innerText();assert.ok(projection.length<original.length);
  assert.equal(projection.includes('ORIGINAL_RESPONSE_END'),false);
  await expand.click();
  const collapse=page.getByRole('button',{name:'Collapse message',exact:true});await collapse.waitFor();
  // Official details fetch bounded pages. Exercise the public pagination UI
  // through the final page instead of assuming one click renders the full body.
  const loadMore=page.getByRole('button',{name:'Load more',exact:true});
  await loadMore.waitFor();let detailPages=0;
  while(await loadMore.count()){
   assert.ok(detailPages++<10,'detail pagination must advance to completion');
   const previousText=await transcript.innerText();await loadMore.click();
   await page.waitForFunction(previous=>{const text=document.querySelector('[role=log]')?.innerText||'';return text.length>previous.length+1000||text.includes('ORIGINAL_RESPONSE_END');},previousText);
  }
  assert.ok(detailPages>0);assert.equal((await transcript.innerText()).includes('ORIGINAL_RESPONSE_END'),true);
  await collapse.click();await expand.waitFor();
  assert.equal((await transcript.innerText()).includes('ORIGINAL_RESPONSE_END'),false);
  await send();await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.body?.request)[1].body.request.messages.find(m=>m.role==='assistant').content),original);

  // Later pages can remain pending while the initial model is usable.
  await page.goto(url+'?mode=progressive');await choose();await send();
  await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
  await page.waitForFunction(()=>typeof window.releaseRoutes==='function');await page.evaluate(()=>window.releaseRoutes());
  await chooseModel('anthropic-model · anthropic');
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path.includes('model-routes')).every(r=>new URL(r.path,location.origin).searchParams.get('limit')==='100')),true);

  // Configured keys can arrive after page one; a deliberate user choice wins.
  await page.goto(url+'?mode=late-key');await page.waitForFunction(()=>typeof window.releaseKeys==='function');
  await page.evaluate(()=>window.releaseKeys());await page.waitForFunction(()=>document.querySelector('#mtp-key')?.value==='key-late');
  await page.goto(url+'?mode=late-key');await page.waitForFunction(()=>typeof window.releaseKeys==='function');
  await page.locator('#mtp-key').selectOption('key-2');await page.evaluate(()=>window.releaseKeys());
  await page.locator('#mtp-key option[value="key-late"]').waitFor({state:'attached'});
  assert.equal(await page.locator('#mtp-key').inputValue(),'key-2');
  await page.goto(url+'?mode=retry');await page.getByText('Route service temporarily unavailable',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Retry',exact:true}).click();await choose();await send();
  await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();

  // The core receives stable conversation metadata and new turn IDs.
  await page.goto(url);await choose();await send();await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  await send();await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  await page.waitForFunction(()=>window.requests.filter(r=>r.body?.request).length===2);
  const turns=await page.evaluate(()=>window.requests.filter(r=>r.body?.request).map(r=>r.body.conversation));
  assert.ok(turns[0].id);assert.equal(turns[1].id,turns[0].id);assert.notEqual(turns[1].turn_id,turns[0].turn_id);assert.equal(turns[1].parent_turn_id,turns[0].turn_id);
  await page.getByRole('button',{name:'Clear',exact:true}).click();await send();await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  const cleared=await page.evaluate(()=>window.requests.filter(r=>r.body?.request).at(-1).body.conversation);
  assert.notEqual(cleared.id,turns[0].id);assert.equal(Object.hasOwn(cleared,'parent_turn_id'),false);
  await page.locator('#mtp-key').selectOption('key-2');await send();await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  const changedKey=await page.evaluate(()=>window.requests.filter(r=>r.body?.request).at(-1).body.conversation);
  assert.notEqual(changedKey.id,cleared.id);assert.equal(Object.hasOwn(changedKey,'parent_turn_id'),false);
  await page.evaluate(()=>window.changeTenant());await page.waitForFunction(()=>document.querySelector('#mtp-key')?.value==='key-1');
  assert.equal(await page.getByRole('log').getByText('Hello from model',{exact:true}).count(),0);
  assert.equal(await page.getByRole('log').getByText('Inspect workspace',{exact:true}).count(),0);await send();await page.getByText('Done · Iterations:',{exact:false}).waitFor();
  assert.notEqual(await page.evaluate(()=>window.requests.filter(r=>r.body?.request).at(-1).body.conversation.id),changedKey.id);
  assert.ok(await page.evaluate(()=>window.requests.some(r=>r.path.includes('tenant_external_id=tenant-b'))));

  await page.goto(url);await choose();await page.getByRole('checkbox',{name:'Allow assistant product tools',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'Generate images',exact:true}).check();await send();
  const image=page.getByRole('img',{name:/^Generated image(?::|$)/});await image.waitFor();
  assert.equal(await image.getAttribute('data-testid'),'message-image-attachment');assert.match(await image.getAttribute('src'),/^blob:/);
  await image.evaluate(el=>el.decode());assert.equal(await image.evaluate(el=>el.complete&&el.naturalWidth>0),true);
  const imageRequest=await page.evaluate(()=>window.requests.find(r=>r.path==='/internal/v1/inference/responses'));
  assert.deepEqual(imageRequest.body.request.tools,[{type:'image_generation',model:'gpt-image-2'}]);
  assert.deepEqual(imageRequest.body.request.tool_choice,{type:'image_generation'});
  assert.ok(imageRequest.body.conversation.id);assert.equal(imageRequest.body.key_id,'key-1');
  const download=page.getByRole('link',{name:'Generated image',exact:true});
  assert.match(await download.getAttribute('href'),/^(?:blob:|data:image\/png;base64,)/);assert.match(await download.getAttribute('download'),/\.png$/);
  const downloaded=page.waitForEvent('download');await download.click();const generatedFile=await downloaded;
  assert.equal(await generatedFile.failure(),null);assert.match(generatedFile.suggestedFilename(),/\.png$/);
  const imageStream=await generatedFile.createReadStream();const imageBytes=[];for await(const chunk of imageStream)imageBytes.push(chunk);
  assert.deepEqual(Buffer.concat(imageBytes).subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  for(const mode of ['duplicate-images','budget-images']){
   await page.goto(url+'?mode='+mode);await choose();
   await page.getByRole('checkbox',{name:'Generate images',exact:true}).check();await send();
   await page.getByText('Done · Iterations:',{exact:false}).waitFor();
   const previews=page.getByRole('img',{name:/^Generated image(?::|$)/});
   await previews.first().waitFor();await previews.first().evaluate(el=>el.decode());
   assert.equal(await previews.first().evaluate(el=>el.complete&&el.naturalWidth===1),true,mode+' retains a decoded preview');
   const originals=page.getByRole('link',{name:'Generated image',exact:true});
   await originals.nth(1).waitFor();assert.equal(await originals.count(),2,mode+' retains every original');
   const files=[];
   for(let index=0;index<2;index++){
    const pending=page.waitForEvent('download');await originals.nth(index).click();const file=await pending;
    assert.equal(await file.failure(),null);assert.match(file.suggestedFilename(),/\.png$/);
    const chunks=[];for await(const chunk of await file.createReadStream())chunks.push(chunk);
    const bytes=Buffer.concat(chunks);files.push(bytes);
    assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    if(mode==='budget-images'){
     assert.equal(bytes.length,9*1024*1024);assert.equal(bytes[bytes.length-17],index+1);
    }
   }
   if(mode==='duplicate-images')assert.deepEqual(files[0],files[1]);
   else assert.ok(files[0].length+files[1].length>16*1024*1024);
   assert.equal(await page.getByText('An error occurred:',{exact:false}).count(),0);
  }
  await page.goto(url+'?mode=partial-image');await choose();await page.getByRole('checkbox',{name:'Generate images',exact:true}).check();await send();
  await page.getByText('An error occurred:',{exact:false}).waitFor();assert.equal(await page.getByRole('img',{name:/^Generated image(?::|$)/}).count(),0);

  for(const approval of ['Cancel','Approve']){
   await page.goto(url+'?mode=mutation');await choose();await send();
   const dialog=page.getByRole('dialog');await dialog.waitFor();
   // Visibility can become true during Fluent's entrance fade. Await finite
   // motion completion, then check the actual composited layers before capture.
   await dialog.evaluate(async surface=>{
    const backdrop=document.querySelector('.fui-DialogSurface__backdrop');
    const animations=document.getAnimations().filter(animation=>{
     const target=animation.effect?.target;
     return target instanceof Element&&animation.effect.getComputedTiming().iterations!==Infinity&&
      (surface.contains(target)||target.contains(surface)||target===backdrop||backdrop?.contains(target));
    });
    await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));
   });
   await page.waitForFunction(()=>{
    const surface=document.querySelector('[role=dialog]');
    const backdrop=document.querySelector('.fui-DialogSurface__backdrop');
    if(!surface||!backdrop)return false;
    const effectiveOpacity=element=>{
     let opacity=1;
     for(let node=element;node;node=node.parentElement)opacity*=Number(getComputedStyle(node).opacity);
     return opacity;
    };
    const alpha=color=>{
     const rgba=color.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/);
     return rgba?Number(rgba[1]):color.startsWith('rgb(')?1:0;
    };
    const rect=surface.getBoundingClientRect(),veil=backdrop.getBoundingClientRect();
    const app=document.getElementById('root')?.getBoundingClientRect();
    if(!app)return false;
    const visibleApp={left:Math.max(0,app.left),top:Math.max(0,app.top),right:Math.min(innerWidth,app.right),bottom:Math.min(innerHeight,app.bottom)};
    return effectiveOpacity(surface)===1&&effectiveOpacity(backdrop)===1&&
     alpha(getComputedStyle(surface).backgroundColor)===1&&alpha(getComputedStyle(backdrop).backgroundColor)>0&&
     // Fluent body locking reserves a scrollbar gutter even with overlay scrollbars.
     // Require coverage of every visible app pixel, excluding only space outside its root.
     visibleApp.right>visibleApp.left&&visibleApp.bottom>visibleApp.top&&
     veil.left<=visibleApp.left&&veil.top<=visibleApp.top&&veil.right>=visibleApp.right&&veil.bottom>=visibleApp.bottom&&
     surface.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));
   });
   assert.equal(await dialog.getAttribute('aria-modal'),'true');
   if(approval==='Cancel'){
    const layers=await dialog.evaluate(surface=>({
     surface:{opacity:getComputedStyle(surface).opacity,background:getComputedStyle(surface).backgroundColor},
     backdrop:{opacity:getComputedStyle(document.querySelector('.fui-DialogSurface__backdrop')).opacity,background:getComputedStyle(document.querySelector('.fui-DialogSurface__backdrop')).backgroundColor},
     viewport:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight,innerWidth,innerHeight},
     appRootRect:document.getElementById('root').getBoundingClientRect().toJSON(),
     bodyRect:document.body.getBoundingClientRect().toJSON(),
     bodyStyle:{paddingRight:getComputedStyle(document.body).paddingRight,marginRight:getComputedStyle(document.body).marginRight,overflow:getComputedStyle(document.body).overflow},
     surfaceRect:surface.getBoundingClientRect().toJSON(),
     backdropRect:document.querySelector('.fui-DialogSurface__backdrop').getBoundingClientRect().toJSON(),
     reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches
    }));
    writeFileSync(artifactDir+'/mutation-review-layers.json',JSON.stringify(layers,null,2));
    await page.screenshot({path:artifactDir+'/mutation-review.png',fullPage:true,animations:'disabled'});
   }
   await page.waitForFunction(()=>document.querySelector('[role=dialog]')?.contains(document.activeElement));
   assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
   // aria-modal declares the active modal subtree; a role query still finds
   // background DOM. Validate real keyboard containment in both directions.
   const controls=await dialog.getByRole('button').count();
   assert.equal(controls,2);
   for(const direction of ['Tab','Shift+Tab']){
    for(let step=0;step<controls*3;step++){
     await page.keyboard.press(direction);
     assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,'focus must remain inside the active dialog after '+direction);
    }
   }
   await dialog.getByRole('button',{name:approval,exact:true}).click();
   await page.getByRole('log').filter({hasText:'Hello from model'}).waitFor();
   await page.getByText('Done · Iterations:',{exact:false}).waitFor();
   await page.waitForFunction(()=>{const root=document.getElementById('root');return !root.closest('[aria-hidden=true],[inert]')&&!root.querySelector('[aria-hidden=true] [role=log],[inert] [role=log]')&&document.activeElement?.hasAttribute('data-playground-clear');});
   assert.equal(await page.getByRole('log').count(),1);
   assert.equal(await page.getByRole('button',{name:'Clear',exact:true}).evaluate(el=>el===document.activeElement),true);
   assert.equal(await page.evaluate(()=>window.responses.at(-1)?.choices[0]?.message.content),'Hello from model');
   assert.equal(await page.getByText('An error occurred:',{exact:false}).count(),0);
   assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path==='/internal/v1/widgets').length),approval==='Approve'?1:0);
  }
  await page.goto(url+'?mode=pending');await choose();await send();
  assert.equal(await page.locator('#mtp-key').isDisabled(),true);
  assert.equal(await page.getByRole('checkbox',{name:'Allow assistant product tools',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByText('Stopped. The upstream request may still continue and incur cost.',{exact:true}).waitFor();
  await page.evaluate(()=>window.unmount());
  await page.goto(url+'?mode=403');await page.getByText('Forbidden',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Retry',exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[]);
 }catch(error){
  if(page){
   await page.screenshot({path:artifactDir+'/failure.png',fullPage:true,animations:'disabled'}).catch(()=>{});
   const diagnostic=await page.evaluate(()=>({
    // The page only runs the deterministic mock above. Record summaries, never raw bodies.
    mode:new URLSearchParams(location.search).get('mode'),
    requests:(window.requests||[]).map(r=>({path:r.path,method:r.method||'GET',model:r.body?.request?.model,keyId:r.body?.key_id})),
    assistantResponses:(window.responses||[]).map(r=>r.choices?.[0]?.message?.content),
    transcript:document.querySelector('[role=log]')?.innerText,
    alerts:[...document.querySelectorAll('[role=alert]')].map(el=>el.innerText),
    text:document.body.innerText.slice(0,8000),
    selectedModel:document.querySelector('#mtp-model')?.value,
    selectedKey:document.querySelector('#mtp-key')?.value,
    dialogLayers:{
     appRootRect:document.getElementById('root')?.getBoundingClientRect().toJSON(),
     bodyRect:document.body.getBoundingClientRect().toJSON(),
     bodyStyle:{paddingRight:getComputedStyle(document.body).paddingRight,marginRight:getComputedStyle(document.body).marginRight,overflow:getComputedStyle(document.body).overflow},
     viewport:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight,innerWidth,innerHeight},
     layers:[...document.querySelectorAll('[role=dialog],.fui-DialogSurface__backdrop')].map(el=>({
      role:el.getAttribute('role'),className:el.className,opacity:getComputedStyle(el).opacity,
      background:getComputedStyle(el).backgroundColor,rect:el.getBoundingClientRect().toJSON(),
      ancestorOpacities:Array.from((function*(node){while(node){yield getComputedStyle(node).opacity;node=node.parentElement;}})(el))
     }))
    }
   })).catch(()=>({pageUnavailable:true}));
   writeFileSync(artifactDir+'/failure.json',JSON.stringify({...diagnostic,pageErrors:errors,failure:String(error)},null,2));
  }
  throw error;
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
