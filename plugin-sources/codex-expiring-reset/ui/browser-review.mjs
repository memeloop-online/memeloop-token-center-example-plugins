// CI-only browser acceptance. Fixture values never ship in the plugin package.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifact = `${root}dist/codex-expiring-reset-browser`;
mkdirSync(artifact, { recursive: true });
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as Fluent from '@fluentui/react-components';
import {activateOperatorUi} from './dist/codex-expiring-reset/ui/codex-expiring-reset.mjs';
const pkg=activateOperatorUi({React,Fluent,defineOperatorUiPackage:x=>x});
const mode=new URLSearchParams(location.search).get('mode');
window.requests=[];window.navigations=[];
let grant=null;
const operation=mode==='unknown'||mode==='accepted'?{id:'fixture-operation',upstream_account_id:'fixture-account',state:mode,settled_at:null}:null;
const api={navigate:(...args)=>window.navigations.push(args),requestApi:async request=>{
 window.requests.push({path:request.path,method:request.method||'GET',body:request.body});
 const url=new URL(request.path,location.origin);
 const tenant=url.searchParams.get('tenant_external_id');
 if(tenant!=='review-tenant'&&tenant!=='other-tenant')throw new Error('Missing tenant');
 if(url.pathname==='/internal/v1/upstreams'){
  if(mode==='error')throw Object.assign(new Error('Forbidden'),{status:403});
  if(mode==='empty')return [];
  return [{id:'fixture-account',name:'Codex 研发账号',driver:'openai-codex',tenant_external_id:tenant},{id:'fixture-other',name:'Codex 备用账号',driver:'openai-codex',tenant_external_id:tenant},{id:'ignored',name:'Other provider',driver:'other'}];
 }
 if(url.pathname.endsWith('/quota')){
  if(mode==='quota-error')throw new Error('unavailable');
  return {contract_version:'upstream_quota_v1',upstream_account_id:url.pathname.includes('fixture-other')?'fixture-other':'fixture-account',tenant_external_id:tenant,status:'ready',freshness:'fresh',stale:false,stale_after:Date.now()+600000,observed_at:Date.now(),reset_capability:{available_credits:2,credit_error_code:null},reset_credits:[{status:'available',granted_at:Date.now()-60000,expires_at:Date.now()+1200000},{status:'available',granted_at:Date.now()-60000,expires_at:Date.now()+86400000}]};
 }
 if(url.pathname.includes('/background-actions/')){
  if(request.method==='PUT'){
   if(mode==='conflict')throw Object.assign(new Error('Conflict'),{status:409});
   if(mode==='readonly')throw new Error('Unexpected write in readonly');
   grant={plugin_id:'mtc-codex-expiring-reset',tenant_external_id:tenant,upstream_account_id:'fixture-account',enabled:request.body.enabled,revision:(grant?.revision||0)+1,last_attempt_at:null,last_result:null};
  }
  return {grant,can_write:mode!=='readonly',operation};
 }
 throw new Error('Unexpected request');
}};
const view=createRoot(document.getElementById('root'));
function render(tenantExternalId='review-tenant'){view.render(React.createElement(Fluent.FluentProvider,{theme:Fluent.webLightTheme},React.createElement(pkg.components.workspace,{api,tenantExternalId,locale:'zh-CN'})));}
window.changeTenant=()=>render('other-tenant');render();
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
  async function choose() {
    await page.getByRole('combobox').click();
    await page.getByRole('combobox').fill('研发');
    await page.getByRole('option', { name: 'Codex 研发账号', exact: true }).click();
    await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('section[aria-busy="true"]'));
  }
  async function screenshot(name) { await page.screenshot({ path: `${artifact}/${name}.png`, fullPage: true, animations: 'disabled' }); }
  await open();
  await choose();
  assert.equal(await page.getByText('2 次', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('switch').isChecked(), false);
  assert.equal(await page.evaluate(() => window.requests.some(r => r.method !== 'GET')), false);
  await screenshot('desktop-disabled');
  await page.getByRole('switch').click();
  await page.getByText('已开启此账号的自动使用授权。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.requests.find(r => r.method === 'PUT').body), { enabled: true, expected_revision: 0 });
  await screenshot('desktop-enabled');
  await page.getByRole('switch').click();
  await page.getByText('已关闭授权，系统不会再发起新的自动使用。已发出的请求仍需核实结果。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').isChecked(), false);
  assert.deepEqual(await page.evaluate(() => window.requests.filter(r => r.method === 'PUT').at(-1).body), { enabled: false, expected_revision: 1 });
  checks.push('search, explicit opt-in, optimistic revision, opt-out');
  await page.evaluate(() => window.changeTenant());
  await page.getByText('选择一个账号查看设置', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').count(), 0);
  checks.push('tenant transition clears selection and grant');
  await open('readonly'); await choose();
  assert.equal(await page.getByRole('switch').isDisabled(), true);
  await page.getByText('当前为只读模式，没有修改自动使用授权的权限。', { exact: true }).waitFor();
  await screenshot('readonly');
  await open('unknown'); await choose();
  assert.equal(await page.getByRole('switch').isDisabled(), true);
  await page.getByText('上次使用结果尚不明确，后续自动使用已停止。请查看下方重置记录；核实前不要再次手动使用。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开上游账号' }).click();
  assert.deepEqual(await page.evaluate(() => window.navigations), [['upstreams']]);
  await screenshot('unknown-result');
  checks.push('readonly permissions, unknown result blocks enabling, existing records entry');
  await open('accepted'); await choose();
  assert.ok(await page.getByText('已使用一次', { exact: true }).count() > 0);
  await screenshot('accepted-result');
  await open('conflict'); await choose(); await page.getByRole('switch').click();
  await page.getByText('授权已被其他操作更新。请刷新后再确认，未覆盖现有设置。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').isDisabled(), true);
  checks.push('409 invalidates stale grant');
  await open('quota-error'); await choose();
  await page.getByText('手动重置次数信息暂不可确认或已过期。系统会重新检查可用次数和到期时间，当前不展示预计执行时间。', { exact: true }).waitFor();
  await screenshot('quota-unavailable');
  await open('empty'); await page.getByText('暂无 Codex 账号', { exact: true }).waitFor(); await screenshot('empty');
  await open('error'); await page.getByRole('button', { name: '重试', exact: true }).waitFor(); await screenshot('permission-error');
  checks.push('quota failure, empty accounts, read permissions');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(); await choose(); await screenshot('mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.evaluate(() => window.requests.some(r => r.path.includes('/confirm') || r.path.includes('/prepare') || r.path.includes('/inference/'))), false);
  assert.deepEqual(errors, []);
  checks.push('mobile no overflow, no consume or inference requests, no browser errors');
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
