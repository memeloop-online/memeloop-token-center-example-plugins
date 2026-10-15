import {runAgentLoop} from '../agent-loop.mjs';

let React,Fluent;
const PAGE=10;
const MAX_ROUTES=5000;
const MAX_TOOL_RESULT=600;
const OPENAI_PROTOCOLS=['openai'];

const COPY={
zh:{
title:'文本模型游乐场',
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
billing:'推理使用所选计费密钥。聊天仅临时保存，计费记录会保留。',
noAccess:'路由列出不代表拥有模型访问权限，请以实际推理结果为准。',
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
disabledRoute:'该路由未启用或协议不受支持（仅支持 OpenAI 兼容协议）。',
roleUser:'用户',
roleAssistant:'助手',
assistantThinking:'思考中…',
keyDisabled:'无可用计费密钥。'
},
en:{
title:'Text Model Playground',
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
billing:'Inference uses the selected billing key. Chat is temporary; billing records remain.',
noAccess:'A listed route does not imply model access; actual inference results apply.',
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
disabledRoute:'Route is disabled or uses an unsupported protocol (OpenAI-compatible only).',
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

export async function fetchPages(api,path,signal,idField='id'){
const out=[],seen=new Set();
let cursor='';
for(let page=0;page<MAX_ROUTES/PAGE;page++){
const batch=await api.requestApi({path:path+'?limit='+PAGE+cursor,signal});
if(signal?.aborted)throw new DOMException('Aborted','AbortError');
const items=Array.isArray(batch)?batch:batch?.items;
if(!Array.isArray(items))throw new Error('Invalid list response');
let added=0;
for(const item of items){const id=item?.[idField];if(id&&!seen.has(id)){seen.add(id);out.push(item);added++;}}
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
root:{display:'flex',flexDirection:'column',gap:12,padding:16,background:'#ffffff',color:'#242424',minHeight:0,fontFamily:'inherit'},
filters:{display:'flex',flexWrap:'wrap',gap:12,alignItems:'flex-end'},
field:{display:'flex',flexDirection:'column',gap:4,minWidth:180,flex:'1 1 180px'},
chat:{display:'flex',flexDirection:'column',gap:8,border:'1px solid #e0e0e0',borderRadius:8,padding:12,background:'#fafafa',minHeight:220,maxHeight:420,overflowY:'auto'},
msgUser:{alignSelf:'flex-end',background:'#e8f3ff',borderRadius:8,padding:'6px 10px',maxWidth:'80%',whiteSpace:'pre-wrap',wordBreak:'break-word'},
msgAssistant:{alignSelf:'flex-start',background:'#ffffff',border:'1px solid #e0e0e0',borderRadius:8,padding:'6px 10px',maxWidth:'80%',whiteSpace:'pre-wrap',wordBreak:'break-word'},
msgTool:{alignSelf:'flex-start',background:'#f3f2f1',borderRadius:8,padding:'4px 8px',maxWidth:'80%',fontSize:12,color:'#605e5c'},
composer:{display:'flex',flexWrap:'wrap',gap:8,alignItems:'flex-end'},
row:{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'},
dialog:{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000},
dialogCard:{background:'#fff',borderRadius:8,padding:20,maxWidth:520,width:'90%',boxShadow:'0 8px 24px rgba(0,0,0,0.2)',display:'flex',flexDirection:'column',gap:12},
pre:{background:'#f3f2f1',padding:8,borderRadius:4,overflowX:'auto',fontSize:12,maxHeight:180}
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
const [protocol,setProtocol]=React.useState('all');
const [modelId,setModelId]=React.useState(null);
const [keyId,setKeyId]=React.useState(null);
const [messages,setMessages]=React.useState([]);
const [tools,setTools]=React.useState([]);
const [draft,setDraft]=React.useState('');
const [busy,setBusy]=React.useState(false);
const [statusNote,setStatusNoteState]=React.useState(null);
const setStatusNote=(text,intent='info')=>setStatusNoteState(text?{text,intent}:null);
const rootRef=React.useRef(null);
const restoreReviewFocusRef=React.useRef(false);
const [review,setReview]=React.useState(null);
const mountedRef=React.useRef(true);
const generationRef=React.useRef(0);
const abortRef=React.useRef(null);
const sendMutexRef=React.useRef(false);
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
setBusy(false);setMessages([]);setTools([]);setReview(null);setModelId(null);setKeyId(null);setDraft('');setStatusNote(null);
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
(async()=>{
try{
const [routeList,keyList]=await Promise.all([
fetchPages(api,'/internal/v1/model-routes',ctrl.signal),
fetchPages(api,'/internal/v1/keys',ctrl.signal,'key_id').then(normalizeKeys)
]);
if(!alive||!mountedRef.current)return;
setRoutes(routeList);
setKeys(keyList);
setLoadState({status:'ready',error:null,forbidden:false});
}catch(err){
if(!alive||!mountedRef.current)return;
if(err&&(err.name==='AbortError'))return;
const status=err&&(err.status||err.statusCode);
setLoadState({status:'error',error:err,forbidden:status===403});
}
})();
return()=>{alive=false;ctrl.abort();};
},[supported,tenantKey,api,reloadTick]);

const usableRoutes=React.useMemo(()=>routes.filter(r=>r&&r.enabled&&OPENAI_PROTOCOLS.indexOf(r.protocol)>=0),[routes]);

const protocols=React.useMemo(()=>{
const set=new Set();
usableRoutes.forEach(r=>set.add(r.protocol));
return Array.from(set);
},[usableRoutes]);

const filtered=React.useMemo(()=>{
const q=search.trim().toLowerCase();
return usableRoutes.filter(r=>{
if(protocol!=='all'&&r.protocol!==protocol)return false;
if(!q)return true;
return (r.public_model||'').toLowerCase().includes(q)||(r.upstream_model||'').toLowerCase().includes(q);
});
},[usableRoutes,search,protocol]);

const contextModel=context&&context.modelRoute&&context.modelRoute.public_model;

React.useEffect(()=>{
if(modelId||!contextModel)return;
const match=usableRoutes.find(r=>r.public_model===contextModel);
if(match)setModelId(match.id);
},[usableRoutes,contextModel,modelId]);

const selectedRoute=React.useMemo(()=>filtered.find(r=>r.id===modelId)||null,[filtered,modelId]);
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

const send=async()=>{
if(sendMutexRef.current||busy)return;
const text=draft.trim();
if(!text)return;
if(!selectedRoute){setStatusNote(t.selectModelFirst,'warning');return;}
if(!selectedKey){setStatusNote(t.selectKeyFirst,'warning');return;}
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
setDraft('');
try{
const result=await runAgentLoop({
api,
keyId:selectedKey.id,
model:selectedRoute.public_model,
messages:base,
signal:ctrl.signal,
confirmMutation,
maxIterations:8,
onEvent:(ev)=>{
if(!current()||ctrl.signal.aborted)return;
if(!ev)return;
if(ev.type==='assistant'&&ev.message){
const content=ev.message.content;
setMessages(prev=>prev.concat([{role:'assistant',content:typeof content==='string'?content:''}]));
}else if(ev.type==='tool'){
setTools(prev=>prev.concat([{name:ev.name||t.tool,status:ev.status||'',result:ev.result!=null?truncate(ev.result,MAX_TOOL_RESULT):null}]).slice(-50));
}
}
});
if(!current())return;
if(result&&Array.isArray(result.messages)){
setMessages(result.messages.map(m=>({role:m.role,content:typeof m.content==='string'?m.content:''})));
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
setDraft(text);
setStatusNote(t.error+': '+(err&&err.message?err.message:String(err)),'error');
}
}finally{
if(abortRef.current===ctrl)abortRef.current=null;
if(current()){sendMutexRef.current=false;setBusy(false);}
}
};

const clearChat=()=>{if(busy)return;setMessages([]);setTools([]);setStatusNote(null);};

const header=h(Fluent.Text,{as:'h2',size:600,weight:'semibold'},t.title);

const filterBar=h('div',{style:styles.filters},
h('div',{style:styles.field},
h('label',{htmlFor:'mtp-search'},t.search),
h(Fluent.Input,{id:'mtp-search',value:search,disabled:busy,onChange:(e,d)=>setSearch(d&&d.value!=null?d.value:'')})),
h('div',{style:styles.field},
h('label',{htmlFor:'mtp-protocol'},t.protocol),
h(Fluent.Select,{id:'mtp-protocol',value:protocol,disabled:busy,onChange:(e)=>setProtocol(e.target.value)},
h('option',{value:'all'},t.protocolAll),
protocols.map(p=>h('option',{key:p,value:p},p)))));

let body;
if(loadState.status==='loading'){
body=h('div',{style:styles.row},h(Fluent.Spinner,{size:'small',label:t.loading,labelPosition:'after'}));
}else if(loadState.status==='error'){
body=h(Fluent.MessageBar,{intent:loadState.forbidden?'warning':'error'},
h(Fluent.MessageBarBody,null,
loadState.forbidden?t.err403:(loadState.error&&loadState.error.message||t.error),
' ',
h(Fluent.Button,{size:'small',onClick:()=>setReloadTick(n=>n+1)},t.retry)));
}else{
const modelField=h('div',{style:styles.field},
h('label',{htmlFor:'mtp-model'},t.model),
h(Fluent.Select,{id:'mtp-model',value:selectedRoute?.id||'',disabled:busy,onChange:e=>setModelId(e.target.value||null)},
h('option',{value:''},t.modelPlaceholder),
filtered.map(r=>h('option',{key:r.id,value:r.id},r.public_model))),
filtered.length===0&&h(Fluent.Text,{size:200},t.empty));

const keyField=h('div',{style:styles.field},
h('label',{htmlFor:'mtp-key'},t.key),
h(Fluent.Select,{id:'mtp-key',value:selectedKey?.id||'',disabled:busy,onChange:e=>setKeyId(e.target.value||null)},
h('option',{value:''},t.keyPlaceholder),
keys.map(k=>h('option',{key:k.id,value:k.id},(k.alias||k.key_id||k.id)+(k.status?' ('+k.status+')':'')))),
keys.length===0&&h(Fluent.Text,{size:200},t.keyDisabled));

const routeInfo=selectedRoute&&h('div',{style:styles.row},
h(Fluent.Badge,{appearance:'outline',color:'informative'},selectedRoute.protocol),
h(Fluent.Text,{size:200},t.model+': '+selectedRoute.public_model),
h(Fluent.Text,{size:200},t.upstream+': '+selectedRoute.upstream_model));

const notices=h('div',{style:{display:'flex',flexDirection:'column',gap:6}},
h(Fluent.MessageBar,{intent:'info'},h(Fluent.MessageBarBody,null,t.billing,' ',t.noAccess)),
statusNote&&h(Fluent.MessageBar,{intent:statusNote.intent},h(Fluent.MessageBarBody,null,statusNote.text)));

const transcript=h('div',{style:styles.chat,role:'log','aria-live':'polite','aria-label':t.title},
messages.map((m,i)=>h('div',{key:'m'+i,style:m.role==='user'?styles.msgUser:styles.msgAssistant},
h(Fluent.Text,{size:200,weight:'semibold',style:{display:'block',marginBottom:2}},m.role==='user'?t.roleUser:t.roleAssistant),
m.content||(m._live?t.assistantThinking:''))),
tools.map((tl,i)=>h('div',{key:'t'+i,style:styles.msgTool},t.tool+': '+tl.name+(tl.status?' · '+tl.status:'')+(tl.result?' — '+tl.result:''))),
busy&&h('div',{style:styles.row},h(Fluent.Spinner,{size:'tiny'}),h(Fluent.Text,{size:200},t.running)));

const composer=h('div',{style:styles.composer},
h(Fluent.Textarea,{value:draft,disabled:busy,'aria-label':t.input,placeholder:t.input,resize:'vertical',style:{flex:'1 1 180px',minWidth:0},onChange:(e,d)=>setDraft(d&&d.value!=null?d.value:''),onKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}),
h(Fluent.Button,{appearance:'primary',disabled:busy||!draft.trim()||!selectedRoute||!selectedKey,onClick:send},t.send),
h(Fluent.Button,{disabled:!busy,onClick:stopRun},t.stop),
h(Fluent.Button,{'data-playground-clear':true,disabled:busy,onClick:clearChat},t.clear));

body=h(React.Fragment,null,h('div',{style:styles.filters},modelField,keyField),routeInfo,notices,transcript,composer);
}

return h('div',{style:styles.root,ref:rootRef},
header,
filterBar,
body,
h(ReviewDialog,{request:review,t:t,onResolve:resolveReview}));
}

function OpenModel({context,api,locale}){
const h=React.createElement;
const route=context&&context.modelRoute;
const enabled=!!(route&&route.enabled&&route.protocol!=='anthropic'&&OPENAI_PROTOCOLS.indexOf(route.protocol)>=0);
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
compatiblePluginVersions:['1.0.0'],
components:{workspace:Workspace,'open-model':OpenModel}
});
}