import {runAgentLoop} from '../agent-loop.mjs';
import {PlaygroundChat} from './chat-adapter.mjs';

let React,Fluent;
const PAGE=100;
const MAX_ROUTES=5000;
const MAX_TOOL_RESULT=600;
const TEXT_PROTOCOLS=['openai','anthropic','responses'];

const COPY={
zh:{
title:'模型游乐场',
requestRecords:'请求记录',
sessionRecords:'会话记录',
generationTasks:'生成任务',
search:'搜索模型',
protocol:'协议',
protocolAll:'全部协议',
model:'模型',
key:'计费密钥',
keyPlaceholder:'选择计费密钥',
modelPlaceholder:'选择已启用模型',
loading:'正在加载…',
retry:'重试',
empty:'没有符合条件的已启用模型。',
err403:'没有读取权限（需要 keys:read）。请联系管理员授权。',
unsupported:'当前宿主不支持此插件所需的 API，请升级控制平面版本。',
toolsHelp:'助手可以查询产品中的模型、请求和用量，也可以提出配置变更。执行变更前会展示操作内容，请你确认。',
imageGeneration:'生成图片',
imageHelp:'使用所选模型调用 GPT Image 2 生成图片，图片会显示在对话中。',
generatedImage:'生成的图片',
downloadImage:'下载图片',
imageLoadFailed:'图片加载失败，请重试。',
reloadMessage:'重新加载',
loadMore:'继续阅读',
moreMessage:'展开阅读完整内容',
downloadMessage:'下载全文',
toolInput:'工具输入',
toolOutput:'工具结果',
expandMessage:'展开全文',
collapseMessage:'收起全文',
otherModels:'其他模型',
loadingModels:'正在加载模型与路由组…',
loadingKeys:'正在加载计费密钥…',
input:'输入消息',
send:'发送',
stop:'停止',
clear:'清空',
stopNote:'已停止。上游请求可能仍在继续并产生费用。',
maxIter:'已达到最大迭代次数，任务可能未完成。',
iter:'迭代',
done:'完成',
error:'发生错误',
tool:'工具',
running:'运行中',
reviewTitle:'变更操作确认',
reviewBody:'模型请求执行以下变更操作，请确认：',
approve:'批准',
cancel:'取消',
upstream:'上游模型',
selectKeyFirst:'请先选择计费密钥。',
selectModelFirst:'请先选择模型。',
openInPlayground:'在游乐场打开',
disabledRoute:'请启用此路由，并使用 OpenAI、Responses 或 Anthropic 协议。',
enableTools:'允许助手使用产品工具',
roleUser:'用户',
roleAssistant:'助手',
assistantThinking:'思考中…',
keyDisabled:'无可用计费密钥。'
},
en:{
title:'Model Playground',
requestRecords:'Request records',
sessionRecords:'Session records',
generationTasks:'Generation tasks',
search:'Search models',
protocol:'Protocol',
protocolAll:'All protocols',
model:'Model',
key:'Billing key',
keyPlaceholder:'Select a billing key',
modelPlaceholder:'Select an enabled model',
loading:'Loading…',
retry:'Retry',
empty:'No enabled models match the filters.',
err403:'Missing read permission (keys:read required). Contact your administrator.',
unsupported:'This host does not provide the APIs required by this plugin. Please upgrade the control plane.',
toolsHelp:'The assistant can look up models, requests and usage, and propose configuration changes. You review and confirm each change before it runs.',
imageGeneration:'Generate images',
imageHelp:'Use the selected model to call GPT Image 2. Generated images appear in the conversation.',
generatedImage:'Generated image',
downloadImage:'Download image',
imageLoadFailed:'Image loading failed. Please try again.',
reloadMessage:'Reload',
loadMore:'Load more',
moreMessage:'Open the full message to continue reading',
downloadMessage:'Download full message',
toolInput:'Tool input',
toolOutput:'Tool output',
expandMessage:'Show full message',
collapseMessage:'Collapse message',
otherModels:'Other models',
loadingModels:'Loading models and route groups…',
loadingKeys:'Loading billing keys…',
input:'Type a message',
send:'Send',
stop:'Stop',
clear:'Clear',
stopNote:'Stopped. The upstream request may still continue and incur cost.',
maxIter:'Maximum iterations reached; the task may be incomplete.',
iter:'Iterations',
done:'Done',
error:'An error occurred',
tool:'Tool',
running:'Running',
reviewTitle:'Confirm mutation',
reviewBody:'The model requests the following mutation. Please review:',
approve:'Approve',
cancel:'Cancel',
upstream:'Upstream model',
selectKeyFirst:'Select a billing key first.',
selectModelFirst:'Select a model first.',
openInPlayground:'Open in Playground',
disabledRoute:'Enable this route and choose OpenAI, Responses or Anthropic protocol.',
enableTools:'Allow assistant product tools',
roleUser:'You',
roleAssistant:'Assistant',
assistantThinking:'Thinking…',
keyDisabled:'No usable billing keys.',
roleUserPh:''
}
};

function copyFor(locale){
const zh=typeof locale==='string'&&locale.toLowerCase().startsWith('zh');
return COPY[zh?'zh':'en'];
}

function truncate(s,n){
const str=typeof s==='string'?s:JSON.stringify(s);
if(str==null)return '';
return str.length>n?str.slice(0,n)+'…':str;
}

export async function fetchPages(api,path,signal,idField='id',onPage){
const out=[],seen=new Set();
let cursor='';
for(let page=0;page<MAX_ROUTES/PAGE;page++){
const batch=await api.requestApi({path:path+(path.includes('?')?'&':'?')+'limit='+PAGE+cursor,signal});
if(signal?.aborted)throw new DOMException('Aborted','AbortError');
const items=Array.isArray(batch)?batch:batch?.items;
if(!Array.isArray(items))throw new Error('Invalid list response');
let added=0;
for(const item of items){const id=item?.[idField];if(id&&!seen.has(id)){seen.add(id);out.push(item);added++;}}
onPage?.([...out]);
if(items.length<PAGE)return out;
const last=items.at(-1);
if(!added||last?.created_at==null||!last?.[idField])throw new Error('List pagination did not advance');
cursor='&before_created_at='+encodeURIComponent(last.created_at)+'&before_id='+encodeURIComponent(last[idField]);
}
throw new Error('Too many entries; narrow the tenant scope before loading the playground');
}

export function normalizeKeys(data){
return data.filter(k=>k&&k.key_id&&(k.status==null||k.status==='active')&&k.enabled!==false).map(k=>({...k,id:k.key_id}));
}

const styles={
root:{display:'flex',flexDirection:'column',gap:12,padding:16,background:'var(--colorNeutralBackground1)',color:'var(--colorNeutralForeground1)',minHeight:0,fontFamily:'inherit'},
filters:{display:'flex',flexWrap:'wrap',gap:12,alignItems:'flex-end'},
field:{display:'flex',flexDirection:'column',gap:4,minWidth:180,flex:'1 1 180px'},
row:{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'},
pre:{background:'var(--colorNeutralBackground3)',padding:8,borderRadius:4,overflowX:'auto',fontSize:12,maxHeight:180}
};

function ReviewDialog({request,t,onResolve}){
const h=React.createElement;
return h(Fluent.Dialog,{open:Boolean(request),onOpenChange:(_e,data)=>{if(!data.open)onResolve(false);}},
h(Fluent.DialogSurface,null,h(Fluent.DialogBody,null,
h(Fluent.DialogTitle,null,t.reviewTitle),
h(Fluent.DialogContent,null,h(Fluent.Text,null,t.reviewBody),
h('pre',{style:styles.pre},String(request?.method||'').toUpperCase()+' '+String(request?.path||'')+'\n'+(request?.body?truncate(JSON.stringify(request?.body,null,2),1500):''))),
h(Fluent.DialogActions,null,
h(Fluent.Button,{appearance:'primary',onClick:()=>onResolve(true)},t.approve),
h(Fluent.Button,{onClick:()=>onResolve(false)},t.cancel)))));
}

function Workspace({locale,context,api,tenantExternalId}){
const h=React.createElement;
const t=copyFor(locale);
const [routes,setRoutes]=React.useState([]);
const [keys,setKeys]=React.useState([]);
const [loadState,setLoadState]=React.useState({status:'loading',error:null,forbidden:false});
const [search,setSearch]=React.useState('');
const [modelOpen,setModelOpen]=React.useState(false);
const [groups,setGroups]=React.useState([]);
const [settings,setSettings]=React.useState(null);
const [resourceLoading,setResourceLoading]=React.useState({routes:true,keys:true});
const [enableImageGeneration,setEnableImageGeneration]=React.useState(false);
const [modelId,setModelId]=React.useState(null);
const [keyId,setKeyId]=React.useState(null);
const [messages,setMessages]=React.useState([]);
const [tools,setTools]=React.useState([]);
const [busy,setBusy]=React.useState(false);
const [enableTools,setEnableTools]=React.useState(true);
const [statusNote,setStatusNoteState]=React.useState(null);
const setStatusNote=(text,intent='info')=>setStatusNoteState(text?{text,intent}:null);
const rootRef=React.useRef(null);
const modelTouchedRef=React.useRef(false);
const keyTouchedRef=React.useRef(false);
const restoreReviewFocusRef=React.useRef(false);
const [review,setReview]=React.useState(null);
const mountedRef=React.useRef(true);
const generationRef=React.useRef(0);
const abortRef=React.useRef(null);
const sendMutexRef=React.useRef(false);
const conversationRef=React.useRef({id:null,lastTurnId:null});
const reviewResolveRef=React.useRef(null);
const [reloadTick,setReloadTick]=React.useState(0);

React.useEffect(()=>{
if(!busy&&!review&&restoreReviewFocusRef.current){
restoreReviewFocusRef.current=false;
rootRef.current?.querySelector('[data-playground-clear]')?.focus();
}
},[busy,review]);

const supported=api&&typeof api.requestApi==='function'&&typeof api.discoverApi==='function';
const tenantKey=tenantExternalId||'';

React.useEffect(()=>{
mountedRef.current=true;
generationRef.current++;
sendMutexRef.current=false;
modelTouchedRef.current=false;keyTouchedRef.current=false;
conversationRef.current={id:crypto.randomUUID(),lastTurnId:null};
setRoutes([]);setKeys([]);setGroups([]);setSettings(null);setSearch('');setModelOpen(false);setEnableImageGeneration(false);
setBusy(false);setMessages([]);setTools([]);setReview(null);setModelId(null);setKeyId(null);setStatusNote(null);
return()=>{
generationRef.current++;
mountedRef.current=false;
if(abortRef.current){abortRef.current.abort();abortRef.current=null;}
if(reviewResolveRef.current){const r=reviewResolveRef.current;reviewResolveRef.current=null;r(false);}
};
},[tenantKey,api]);

React.useEffect(()=>{
if(!supported)return;
const ctrl=new AbortController();
let alive=true;
setLoadState({status:'loading',error:null,forbidden:false});
setResourceLoading({routes:true,keys:true});
const scoped=path=>path+(tenantKey?'?tenant_external_id='+encodeURIComponent(tenantKey):'');
const update=(fn)=>value=>{if(alive&&mountedRef.current)fn(value);};
const reportFailure=error=>{
if(alive&&mountedRef.current&&error?.name!=='AbortError')setLoadState({status:'error',error,forbidden:(error?.status||error?.statusCode)===403});
throw error;
};
const loadResource=(name,path,idField,setter)=>fetchPages(api,scoped(path),ctrl.signal,idField,update(setter)).catch(reportFailure)
.finally(()=>{if(alive&&mountedRef.current)setResourceLoading(prev=>({...prev,[name]:false}));});
Promise.allSettled([
loadResource('routes','/internal/v1/model-routes','id',setRoutes),
loadResource('keys','/internal/v1/keys','key_id',value=>setKeys(normalizeKeys(value))),
api.requestApi({path:scoped('/internal/v1/route-groups'),signal:ctrl.signal}).then(update(value=>setGroups(Array.isArray(value)?value:value?.items||[]))).catch(reportFailure),
api.requestApi({path:scoped('/internal/v1/filter-assistant/settings'),signal:ctrl.signal}).then(update(setSettings)).catch(reportFailure)
]).then(results=>{
if(!alive||!mountedRef.current)return;
const failed=results.find(result=>result.status==='rejected'&&result.reason?.name!=='AbortError');
setLoadState(failed?{status:'error',error:failed.reason,forbidden:(failed.reason?.status||failed.reason?.statusCode)===403}:{status:'ready',error:null,forbidden:false});
});
return()=>{alive=false;ctrl.abort();};
},[supported,tenantKey,api,reloadTick]);

const usableRoutes=React.useMemo(()=>routes.filter(r=>r&&r.enabled&&TEXT_PROTOCOLS.indexOf(r.protocol)>=0),[routes]);

const filtered=React.useMemo(()=>{
const q=search.trim().toLowerCase();
return usableRoutes.filter(r=>!q||[r.public_model,r.upstream_model,r.protocol,...(r.route_group_ids||[]).map(id=>groups.find(g=>g.id===id)?.name||id)].some(value=>String(value||'').toLowerCase().includes(q)));
},[usableRoutes,search,groups]);

const groupedRoutes=React.useMemo(()=>{
const result=new Map();
for(const route of filtered){
const memberships=route.route_group_ids?.length?route.route_group_ids:[null];
for(const groupId of memberships){
const group=groups.find(g=>g.id===groupId);
const label=groupId?(group?.name||groupId):t.otherModels;
const id=groupId||'__other';
if(!result.has(id))result.set(id,{id,label,routes:[]});
result.get(id).routes.push(route);
}
}
return [...result.values()].sort((a,b)=>a.id==='__other'?1:b.id==='__other'?-1:a.label.localeCompare(b.label));
},[filtered,groups,t]);

const contextModel=context?.modelRoute?.public_model;
const contextRouteId=context?.modelRoute?.id;

React.useEffect(()=>{
if(modelId||modelTouchedRef.current)return;
const match=usableRoutes.find(r=>contextRouteId?r.id===contextRouteId:contextModel?r.public_model===contextModel:r.id===settings?.model_route_id);
if(match)setModelId(match.id);
},[usableRoutes,contextModel,contextRouteId,modelId,settings]);

React.useEffect(()=>{
if(!keyTouchedRef.current&&!keyId&&settings?.billing_key_id&&keys.some(k=>k.id===settings.billing_key_id))setKeyId(settings.billing_key_id);
},[keys,settings,keyId]);

React.useEffect(()=>{
conversationRef.current={id:crypto.randomUUID(),lastTurnId:null};
setMessages([]);setTools([]);setStatusNote(null);
},[keyId]);

const selectedRoute=React.useMemo(()=>usableRoutes.find(r=>r.id===modelId)||null,[usableRoutes,modelId]);
const selectedKey=React.useMemo(()=>keys.find(k=>k.id===keyId)||null,[keys,keyId]);

if(!supported){
return h('div',{style:styles.root},
h(Fluent.MessageBar,{intent:'warning'},
h(Fluent.MessageBarBody,null,h(Fluent.MessageBarTitle,null,t.title),' ',t.unsupported)));
}

const confirmMutation=(req)=>new Promise(resolve=>{
if(!mountedRef.current){resolve(false);return;}
reviewResolveRef.current=resolve;
setReview(req||{});
});

const resolveReview=(val)=>{
const r=reviewResolveRef.current;
reviewResolveRef.current=null;
setReview(null);
restoreReviewFocusRef.current=true;
if(r)r(!!val);
};

const stopRun=()=>{
if(abortRef.current){abortRef.current.abort();}
if(reviewResolveRef.current)resolveReview(false);
setStatusNote(t.stopNote,'warning');
};

const send=async(input)=>{
if(sendMutexRef.current||busy)return;
const text=input.trim();
if(!text)return;
if(!selectedRoute)throw new Error(t.selectModelFirst);
if(!selectedKey)throw new Error(t.selectKeyFirst);
sendMutexRef.current=true;
setBusy(true);
setStatusNote(null);
setTools([]);
const ctrl=new AbortController();
const generation=generationRef.current;
const current=()=>mountedRef.current&&generationRef.current===generation;
abortRef.current=ctrl;
const base=messages.concat([{role:'user',content:text}]);
setMessages(base);
try{
const result=await runAgentLoop({
api,
keyId:selectedKey.id,
model:selectedRoute.public_model,
protocol:selectedRoute.protocol,
enableTools,
enableImageGeneration:enableImageGeneration&&selectedRoute.protocol!=='anthropic',
imageModel:'gpt-image-2',
conversationId:conversationRef.current.id,
turnId:crypto.randomUUID(),
parentTurnId:conversationRef.current.lastTurnId||undefined,
messages:base,
signal:ctrl.signal,
confirmMutation,
maxIterations:8,
onEvent:(ev)=>{
if(!current()||ctrl.signal.aborted)return;
if(!ev)return;
if(ev.type==='assistant'&&ev.message){
const content=ev.message.content;
setMessages(prev=>prev.concat([{...ev.message,role:'assistant',content:typeof content==='string'?content:''}]));
}else if(ev.type==='tool'){
setTools(prev=>prev.concat([{id:crypto.randomUUID(),name:ev.name||t.tool,status:ev.status||'',result:ev.result!=null?truncate(ev.result,MAX_TOOL_RESULT):null}]).slice(-50));
}
}
});
if(!current())return;
if(result?.lastTurnId)conversationRef.current.lastTurnId=result.lastTurnId;
if(result&&Array.isArray(result.messages)){
setMessages(result.messages.map(m=>({...m,content:typeof m.content==='string'?m.content:''})));
}
if(ctrl.signal.aborted||result?.status==='cancelled'){
setStatusNote(t.stopNote,'warning');
}else if(result&&result.status==='max-iterations'){
setStatusNote(t.maxIter+(result.iterations!=null?' ('+t.iter+': '+result.iterations+')':''),'warning');
}else{
setStatusNote(t.done+(result&&result.iterations!=null?' · '+t.iter+': '+result.iterations:''),'success');
}
}catch(err){
if(!current())return;
if(err&&err.name==='AbortError'){
setStatusNote(t.stopNote,'warning');
}else{
setStatusNote(t.error+': '+(err&&err.message?err.message:String(err)),'error');
throw err;
}
}finally{
if(abortRef.current===ctrl)abortRef.current=null;
if(current()){sendMutexRef.current=false;setBusy(false);}
}
};

const clearChat=()=>{if(busy)return;conversationRef.current={id:crypto.randomUUID(),lastTurnId:null};setMessages([]);setTools([]);setStatusNote(null);};

const header=h('div',{style:{...styles.row,justifyContent:'space-between'}},
h(Fluent.Text,{as:'h2',size:600,weight:'semibold'},t.title),
typeof api.navigate==='function'&&h('div',{style:styles.row},
[['requests',t.requestRecords],['sessions',t.sessionRecords],['generations',t.generationTasks]].map(([view,label])=>h(Fluent.Button,{key:view,size:'small',appearance:'subtle',onClick:()=>api.navigate(view)},label))));

const modelField=h('div',{style:{...styles.field,flex:'2 1 300px'}},
h('label',{htmlFor:'mtp-model'},t.model),
h(Fluent.Combobox,{id:'mtp-model',value:search||selectedRoute?.public_model||'',selectedOptions:selectedRoute?[selectedRoute.id]:[],placeholder:t.search,disabled:busy,open:modelOpen,
onOpenChange:(_e,data)=>setModelOpen(data.open),
onChange:e=>{modelTouchedRef.current=true;setSearch(e.target.value);setModelId(null);setModelOpen(true);},
onOptionSelect:(_e,data)=>{if(data.optionValue){modelTouchedRef.current=true;setModelId(data.optionValue);setSearch('');setModelOpen(false);}},
style:{width:'100%'},listbox:{style:{maxHeight:360}}},
groupedRoutes.map(group=>h(Fluent.OptionGroup,{key:group.id,label:group.label},group.routes.map(r=>h(Fluent.Option,{key:r.id,value:r.id,text:r.public_model},r.public_model+' · '+r.protocol))))),
resourceLoading.routes&&h(Fluent.Spinner,{size:'tiny',label:t.loadingModels,labelPosition:'after'}),
!resourceLoading.routes&&filtered.length===0&&h(Fluent.Text,{size:200},t.empty));

const keyField=h('div',{style:styles.field},
h('label',{htmlFor:'mtp-key'},t.key),
h(Fluent.Select,{id:'mtp-key',value:selectedKey?.id||'',disabled:busy,onChange:e=>{keyTouchedRef.current=true;setKeyId(e.target.value||null);}},
h('option',{value:''},t.keyPlaceholder),
keys.map(k=>h('option',{key:k.id,value:k.id},(k.alias||k.key_id||k.id)+(k.status?' ('+k.status+')':'')))),
resourceLoading.keys&&h(Fluent.Spinner,{size:'tiny',label:t.loadingKeys,labelPosition:'after'}),
!resourceLoading.keys&&keys.length===0&&h(Fluent.Text,{size:200},t.keyDisabled));

const routeInfo=selectedRoute&&h('div',{style:styles.row},
h(Fluent.Badge,{appearance:'outline',color:'informative'},selectedRoute.protocol),
h(Fluent.Text,{size:200},t.model+': '+selectedRoute.public_model),
h(Fluent.Text,{size:200},t.upstream+': '+selectedRoute.upstream_model));

const notices=h('div',{style:{display:'flex',flexDirection:'column',gap:6}},
loadState.status==='error'&&h(Fluent.MessageBar,{intent:'error'},h(Fluent.MessageBarBody,null,loadState.error?.message||t.error,' ',h(Fluent.Button,{size:'small',onClick:()=>setReloadTick(n=>n+1)},t.retry))),
statusNote&&h(Fluent.MessageBar,{intent:statusNote.intent},h(Fluent.MessageBarBody,null,statusNote.text)));

const chat=h(PlaygroundChat,{
key:conversationRef.current.id||'initial',conversationId:conversationRef.current.id||'initial',
messages,tools,busy,ready:!!selectedRoute&&!!selectedKey,send,stop:stopRun,clear:clearChat,t,Fluent,
onError:error=>setStatusNote(t.error+': '+(error?.message||String(error)),'error')
});

const body=h(React.Fragment,null,h('div',{style:styles.filters},modelField,keyField),routeInfo,
h('div',{style:styles.row},
h(Fluent.Checkbox,{label:t.enableTools,checked:enableTools,disabled:busy,'aria-describedby':'mtp-tools-help',onChange:(_e,data)=>setEnableTools(data.checked===true)}),
h(Fluent.Tooltip,{content:t.toolsHelp,relationship:'description'},h(Fluent.Button,{id:'mtp-tools-help',size:'small',appearance:'subtle','aria-label':t.toolsHelp},'?')),
selectedRoute?.protocol!=='anthropic'&&h(React.Fragment,null,h(Fluent.Checkbox,{label:t.imageGeneration,checked:enableImageGeneration,disabled:busy,onChange:(_e,data)=>setEnableImageGeneration(data.checked===true)}),h(Fluent.Tooltip,{content:t.imageHelp,relationship:'description'},h(Fluent.Button,{size:'small',appearance:'subtle','aria-label':t.imageHelp},'?')))),
notices,chat);

return h('div',{style:styles.root,ref:rootRef},
header,
body,
h(ReviewDialog,{request:review,t:t,onResolve:resolveReview}));
}

function OpenModel({context,api,locale}){
const h=React.createElement;
const route=context&&context.modelRoute;
const enabled=!!(route&&route.enabled&&TEXT_PROTOCOLS.indexOf(route.protocol)>=0);
const t=copyFor(locale);
const onClick=()=>{
if(!enabled||!route)return;
if(api&&typeof api.navigate==='function'){
api.navigate('plugin--mtc-text-playground--text-model',{modelRoute:route});
}
};
const btn=h(Fluent.Button,{appearance:'secondary',disabled:!enabled,onClick:onClick,'aria-label':t.openInPlayground},t.openInPlayground);
if(enabled)return btn;
return h('span',{title:t.disabledRoute,style:{display:'inline-flex'}},btn);
}

export function activateOperatorUi({React:ReactHost,Fluent:FluentHost,defineOperatorUiPackage}){
React=ReactHost;
Fluent=FluentHost;
return defineOperatorUiPackage({
apiVersion:'operator-ui-package-v1',
pluginId:'mtc-text-playground',
compatiblePluginVersions:['1.0.0','1.1.0'],
components:{workspace:Workspace,'open-model':OpenModel}
});
}