// CI browser acceptance uses synthetic fixtures in a separate harness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifact = `${root}dist/quota-management-browser`;
mkdirSync(artifact, { recursive: true });
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as Fluent from '@fluentui/react-components';
import {activateOperatorUi} from './plugin-sources/soonest-reset/ui/quota-management.mjs';
const pkg=activateOperatorUi({React,Fluent,defineOperatorUiPackage:x=>x});
const mode=new URLSearchParams(location.search).get('mode');
window.requests=[];
const grants=new Map();
const grantFor=(id,tenant,enabled,revision)=>({plugin_id:'mtc-soonest-reset',tenant_external_id:tenant,upstream_account_id:id,enabled,revision,last_attempt_at:null,last_result:null});
if(mode==='configured')grants.set('review-tenant:fixture-account',grantFor('fixture-account','review-tenant',true,8));
const api={requestApi:async request=>{
 window.requests.push({path:request.path,method:request.method||'GET',body:request.body});
 const url=new URL(request.path,location.origin);
 const tenant=url.searchParams.get('tenant_external_id');
 const id=url.pathname.split('/').at(-1);
 if(!['review-tenant','other-tenant'].includes(tenant)||!['fixture-account','fixture-other'].includes(id)
   ||!url.pathname.startsWith('/internal/v1/plugins/mtc-soonest-reset/background-actions/'))throw new Error('Unexpected request');
 if(mode==='loading')await new Promise(resolve=>window.finishLoading=resolve);
 if(mode==='error')throw Object.assign(new Error('Forbidden'),{status:403});
 const key=tenant+':'+id;
 if(request.method==='PUT'){
   if(mode==='conflict')throw Object.assign(new Error('Conflict'),{status:409});
   if(mode==='save-unknown')throw new Error('Timeout');
   if(mode==='readonly')throw new Error('Unexpected write in readonly');
   const previous=grants.get(key);
   if(request.body.expected_revision!==(previous?.revision||0))throw new Error('Wrong revision');
   grants.set(key,grantFor(id,tenant,request.body.enabled,(previous?.revision||0)+1));
 }
 return {grant:grants.get(key)||null,can_write:mode!=='readonly',operation:['unknown','accepted'].includes(mode)?{id:'fixture-operation',upstream_account_id:id,state:mode,settled_at:null}:null};
}};
const view=createRoot(document.getElementById('root'));
function render(tenantExternalId='review-tenant',id='fixture-account'){
 const context=mode==='missing-context'?{}:{upstreamAccount:{id,name:'Codex 研发账号',provider:mode==='other-provider'?'other':'openai-codex',tenantExternalId:mode==='wrong-tenant'?'wrong':tenantExternalId},
   quotaSnapshot:mode==='quota-error'?undefined:{contract_version:'upstream_quota_v1',upstream_account_id:id,tenant_external_id:tenantExternalId,status:'ready',freshness:'fresh',stale:false,stale_after:Date.now()+600000,observed_at:Date.now(),reset_capability:{available_credits:2,credit_error_code:null},reset_credits:[{status:'available',granted_at:Date.now()-60000,expires_at:Date.now()+1200000}]}};
 view.render(React.createElement(Fluent.FluentProvider,{theme:Fluent.webLightTheme},React.createElement('main',{style:{padding:16,maxWidth:720,margin:'auto'}},
   React.createElement('h2',null,'Codex 研发账号'),React.createElement('section',{'aria-label':'额度重置'},React.createElement('h3',null,'额度重置'),
   mode==='absent'?null:React.createElement(pkg.components['account-reset-settings'],{api,tenantExternalId,context,locale:mode==='english'?'en':'zh-CN'})))));
}
window.changeTenant=()=>render('other-tenant');window.changeAccount=()=>render('review-tenant','fixture-other');render();
`;
const output = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const js = output.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/app.js' ? js : '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex reset browser review fixture</title><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let page;
const errors = [];
const checks = [];
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function open(mode = '') { await page.goto(`${url}/?mode=${mode}`); }
  async function ready() {
    await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-account-reset-settings][aria-busy="true"]'));
  }
  async function screenshot(name) { await page.screenshot({ path: `${artifact}/${name}.png`, fullPage: true, animations: 'disabled' }); }
  await open(); await ready();
  assert.equal(await page.getByRole('combobox').count(), 0);
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 0);
  assert.equal(await page.getByRole('navigation').count(), 0);
  assert.equal(await page.getByRole('region', { name: '额度重置' }).getByRole('switch').count(), 1);
  assert.equal(await page.getByRole('switch').isChecked(), false);
  assert.equal(await page.evaluate(() => window.requests.some(r => r.method !== 'GET')), false);
  await screenshot('desktop-disabled');
  await page.getByRole('switch').click();
  await page.getByText('自动使用已开启', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.requests.find(r => r.method === 'PUT').body), { enabled: true, expected_revision: 0 });
  await screenshot('desktop-enabled');
  await page.getByRole('switch').click();
  await page.getByText('自动使用已关闭', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.requests.filter(r => r.method === 'PUT').at(-1).body), { enabled: false, expected_revision: 1 });
  await page.evaluate(() => window.changeAccount());
  await page.waitForFunction(() => document.querySelector('[data-account-reset-settings]')?.getAttribute('data-account-reset-settings') === 'fixture-other'); await ready();
  await page.getByRole('switch').click();
  await page.getByText('自动使用已开启', { exact: true }).waitFor();
  assert.match(await page.evaluate(() => window.requests.filter(r => r.method === 'PUT').at(-1).path), /background-actions\/fixture-other\?/);
  assert.deepEqual(await page.evaluate(() => window.requests.filter(r => r.method === 'PUT').at(-1).body), { enabled: true, expected_revision: 0 });
  await page.evaluate(() => window.changeTenant());
  await page.waitForFunction(() => window.requests.some(r => r.path.includes('tenant_external_id=other-tenant'))); await ready();
  assert.equal(await page.getByRole('switch').isChecked(), false);
  checks.push('inline settings, current account and tenant scope, revision checks, no account picker or navigation');
  await open('configured'); await ready();
  assert.equal(await page.getByRole('switch').isChecked(), true);
  await page.getByRole('switch').click();
  await page.getByText('自动使用已关闭', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.requests.filter(r => r.method === 'PUT').at(-1).body), { enabled: false, expected_revision: 8 });
  await open('readonly'); await ready();
  assert.equal(await page.getByRole('switch').isDisabled(), true);
  await page.getByText('可查看当前设置。如需修改，请联系管理员。', { exact: true }).waitFor(); await screenshot('readonly');
  for (const mode of ['unknown', 'accepted']) {
    await open(mode); await ready();
    await page.getByText(mode === 'unknown' ? '上次重置结果正在核实，可在当前账号查看重置记录。' : '已提交一次重置，正在核实结果。', { exact: true }).waitFor();
    assert.equal(await page.locator('dd').filter({ hasText: '结果核实中' }).count(), 1);
    assert.equal(await page.getByText('已使用一次', { exact: true }).count(), 0);
    await page.getByRole('switch').click(); await page.getByText('自动使用已开启', { exact: true }).waitFor();
    await page.getByRole('switch').click(); await page.getByText('自动使用已关闭', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.requests.some(r => r.method === 'POST')), false);
    await screenshot(mode+'-result');
  }
  await open('conflict'); await ready(); await page.getByRole('switch').click();
  await page.getByText('设置已被其他操作更新。请刷新状态后确认。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').isDisabled(), true);
  await open('save-unknown'); await ready(); await page.getByRole('switch').click();
  await page.getByText('保存结果待确认。刷新状态查看最新设置。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').isDisabled(), true);
  checks.push('configured grant preserved, read-only permissions, unknown and accepted result handling, conflict and uncertain save recovery');
  await open('quota-error'); await ready();
  assert.equal(await page.getByRole('switch').isEnabled(), true);
  await page.getByText('查看或刷新账号额度后可更新次数与到期时间。', { exact: true }).waitFor(); await screenshot('quota-unavailable');
  await open('error'); await ready();
  assert.equal(await page.getByRole('switch').isDisabled(), true); await screenshot('permission-error');
  await open('loading'); await page.getByText('正在读取自动使用设置…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').isDisabled(), true); await screenshot('loading');
  await page.evaluate(() => window.finishLoading()); await ready();
  for (const mode of ['absent', 'missing-context', 'wrong-tenant', 'other-provider']) {
    await open(mode); await page.getByRole('heading', { name: '额度重置', exact: true }).waitFor();
    assert.equal(await page.getByRole('switch').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.requests), []);
  }
  await open('english'); await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
  assert.equal(await page.getByRole('switch', { name: /Automatically use a manual reset credit/ }).count(), 1);
  checks.push('loading, failed read, unavailable quota, absent plugin, invalid context, unsupported provider, English');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await open('unknown'); await ready();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await screenshot(`inline-${width}`);
  }
  assert.equal(await page.evaluate(() => window.requests.some(r => r.method === 'POST' || !r.path.includes('/background-actions/'))), false);
  assert.deepEqual(errors, []);
  checks.push('desktop and mobile no overflow; no quota refetch, reset consumption, or inference');
  writeFileSync(`${artifact}/evidence.json`, JSON.stringify({ fixtureOnly: true, realConsume: false, checks }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${artifact}/failure.png`, fullPage: true, animations: 'disabled' }).catch(() => {});
    writeFileSync(`${artifact}/failure.html`, await page.content().catch(() => 'Unavailable'));
    writeFileSync(`${artifact}/failure.json`, JSON.stringify({ message: error.message, errors, checks,
      requests: await page.evaluate(() => window.requests).catch(() => []) }, null, 2));
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
