import * as React from 'react';
import {ThemeProvider,createTheme} from '@mui/material/styles';
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline';
import {MemeLoopRuntimeProvider,MemeLoopThread,MemeLoopComposer} from '@memeloop/react-ui/chat';
import {getDisplayTruncation} from '@memeloop/react-ui/chat/core';
import {projectConversationMessageForList} from 'memeloop';

const ComposerContext=React.createContext(null);

function PlaygroundComposer(){
const {t,disabled,clear,busy,Fluent}=React.useContext(ComposerContext);
return React.createElement(MemeLoopComposer,{
labels:{input:t.input,send:t.send,cancel:t.stop},placeholder:t.input,disabled,
renderComposerToolbar:React.createElement(Fluent.Button,{size:'small',appearance:'subtle','data-playground-clear':true,disabled:busy,onClick:clear},t.clear)
});
}

function imageBytes(dataUrl){
const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl||'');
if(!match)throw new Error('Invalid generated image');
return Uint8Array.from(atob(match[2]),character=>character.charCodeAt(0));
}

function projectMessage(full){
const projection=projectConversationMessageForList(full,32768,{detailAvailable:false});
return getDisplayTruncation(projection)?.contentTruncated
?projectConversationMessageForList(full,32768,{detailAvailable:true})
:projection;
}

function useHostTheme(container){
const [theme,setTheme]=React.useState(()=>createTheme());
React.useEffect(()=>{
const element=container.current;
if(!element)return;
const provider=element.closest('.fui-FluentProvider')||document.documentElement;
const read=()=>{
const style=getComputedStyle(element);
const token=(name,fallback)=>style.getPropertyValue(name).trim()||fallback;
const background=style.backgroundColor;
const channels=background.match(/[\d.]+/g)?.slice(0,3).map(Number)||[255,255,255];
const dark=channels[0]*.2126+channels[1]*.7152+channels[2]*.0722<128;
setTheme(createTheme({
palette:{mode:dark?'dark':'light',
primary:{main:token('--colorBrandBackground',dark?'#479ef5':'#0f6cbd')},
background:{default:token('--colorNeutralBackground2',dark?'#1f1f1f':'#fafafa'),paper:token('--colorNeutralBackground1',dark?'#292929':'#ffffff')},
text:{primary:token('--colorNeutralForeground1',dark?'#ffffff':'#242424'),secondary:token('--colorNeutralForeground2',dark?'#d6d6d6':'#424242')},
divider:token('--colorNeutralStroke2',dark?'#444444':'#e0e0e0')},
typography:{fontFamily:style.fontFamily},
components:{MuiButton:{styleOverrides:{root:{textTransform:'none'}}}}
}));
};
read();
const observer=new MutationObserver(read);
observer.observe(provider,{attributes:true,attributeFilter:['class','style','data-theme']});
return()=>observer.disconnect();
},[container]);
return theme;
}

/** Controlled bridge only: the core owns inference, request records and sessions. */
export function PlaygroundChat({conversationId,messages,tools,busy,ready,send,stop,clear,t,Fluent,onError}){
const h=React.createElement;
const container=React.useRef(null);
const theme=useHostTheme(container);
const identities=React.useRef(new Map());
const sequenceRef=React.useRef(0);
const assets=React.useRef(new Map());
const [assetRevision,setAssetRevision]=React.useState(0);
const projectedEntries=React.useMemo(()=>{
let turnId;
const entries=messages.map((message,index)=>{
const messageId=conversationId+':message:'+index;
let identity=identities.current.get(messageId);
if(!identity){
const sequence=++sequenceRef.current;
identity={messageId,conversationId,originNodeId:'mtc-playground',originSequence:sequence,timestamp:Date.now(),lamportClock:sequence};
identities.current.set(messageId,identity);
}
if(message.role==='user')turnId=messageId;
const attachments=(message.images||[]).map((image,imageIndex)=>assets.current.get(messageId+':image:'+imageIndex)).filter(asset=>asset&&asset.dataUrl===message.images[asset.imageIndex]?.dataUrl).map(asset=>asset.reference);
const parts=[{type:'text',text:message.content},...attachments.map(attachment=>({type:'attachment',attachment}))];
const full={...identity,turnId:turnId||messageId,role:message.role,content:message.content,parts,...(attachments.length?{attachments}:{})};
return {full,source:message,projection:projectMessage(full)};
});
for(const tool of tools){
const messageId=conversationId+':tool:'+tool.id;
let identity=identities.current.get(messageId);
if(!identity){
const sequence=++sequenceRef.current;
identity={messageId,conversationId,originNodeId:'mtc-playground',originSequence:sequence,timestamp:Date.now(),lamportClock:sequence};
identities.current.set(messageId,identity);
}
const content=[tool.name,tool.status,tool.result].filter(Boolean).join(' · ');
const full={...identity,turnId:turnId||messageId,role:'tool',content,parts:[{type:'tool-result',toolName:tool.name,result:tool.result||tool.status||''}]};
entries.push({full,source:tool,projection:projectMessage(full)});
}
return entries;
},[conversationId,messages,tools,assetRevision]);
const entriesRef=React.useRef(projectedEntries);
entriesRef.current=projectedEntries;

// Compute real content hashes once; preview bytes are supplied only on the
// official thread's visible-attachment request and URLs are owned by that UI.
React.useEffect(()=>{
let alive=true;
(async()=>{
let changed=false;
for(let index=0;index<messages.length;index++){
for(let imageIndex=0;imageIndex<(messages[index].images||[]).length;imageIndex++){
const image=messages[index].images[imageIndex];
const id=conversationId+':message:'+index+':image:'+imageIndex;
if(assets.current.get(id)?.dataUrl===image.dataUrl)continue;
const bytes=imageBytes(image.dataUrl);
const digest=await crypto.subtle.digest('SHA-256',bytes);
if(!alive)return;
// MemeLoop attachment references use algorithm-prefixed content addresses.
const contentHash='sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
const extension=image.mimeType==='image/jpeg'?'jpg':image.mimeType==='image/webp'?'webp':'png';
assets.current.set(id,{imageIndex,dataUrl:image.dataUrl,reference:{contentHash,mimeType:image.mimeType,filename:'generated-image-'+(index+1)+'-'+(imageIndex+1)+'.'+extension,size:bytes.byteLength}});
changed=true;
}
}
if(changed&&alive)setAssetRevision(value=>value+1);
})().catch(error=>{if(alive)onError(error);});
return()=>{alive=false;};
},[messages,conversationId,onError]);

const loadVisibleAttachments=React.useCallback(async request=>{
request.signal.throwIfAborted();
const entry=entriesRef.current.find(value=>value.full.messageId===request.identity.messageId);
if(!entry)return null;
const attachments=[];
let total=0;
for(let index=0;index<(entry.source.images||[]).length;index++){
const asset=assets.current.get(entry.full.messageId+':image:'+index);
if(!asset)continue;
total+=asset.reference.size;
if(attachments.length>=request.maxCount||total>request.maxBytes)throw new Error(t.imageLoadFailed);
const data=imageBytes(asset.dataUrl);
request.signal.throwIfAborted();
attachments.push({reference:asset.reference,source:{kind:'bytes',data}});
}
return {identity:request.identity,revision:request.revision,attachments};
},[t]);

const loadMessageDetail=React.useCallback(async(message,request)=>{
request.signal.throwIfAborted();
const entry=entriesRef.current.find(value=>value.full.messageId===message.messageId);
if(!entry)return null;
const content=entry.full.content;
const start=request.cursor===undefined?0:Number(request.cursor);
if(!Number.isSafeInteger(start)||start<0||start>content.length)throw new Error(t.error);
// At most four UTF-8 bytes per code point; leave room for the page envelope.
let end=Math.min(content.length,start+Math.min(16384,Math.floor((request.maxBytes-1024)/4)));
if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1]))end--;
const next=end<content.length?String(end):undefined;
return {text:content.slice(start,end),itemCount:1,truncated:!!next,...(next?{nextCursor:next}:{})};
},[t]);

const projections=React.useMemo(()=>projectedEntries.map(entry=>entry.projection),[projectedEntries]);
const adapter={
conversationId,messages:projections,isRunning:busy,isLoading:false,error:null,runningStatus:t.running,
// The controlled transcript already has a bounded inference budget. Keep every
// row reachable instead of silently dropping earlier messages from the widget.
residentMessageLimit:Math.max(200,projections.length),
residentContentByteLimit:Math.max(262144,projections.reduce((total,message)=>total+new TextEncoder().encode(JSON.stringify(message)).length,0)+4096),
residentRenderRowLimit:Math.max(2000,projections.reduce((total,message)=>total+message.content.length+100,0)),
sendMessage:async({text,file,wikiTiddlers})=>{
if(file||wikiTiddlers?.length)throw new Error(t.input);
await send(text);
},
cancel:async()=>stop(),
// These commands have no visible controls: core records stay managed in core.
deleteTurn:async()=>{},retryTurn:async()=>{},
loadMessageDetail,loadVisibleAttachments,
onError
};
const renderTurnActions=message=>{
const entry=entriesRef.current.find(value=>value.full.messageId===message.messageId);
return (entry?.source.images||[]).map((image,index)=>{
const asset=assets.current.get(message.messageId+':image:'+index);
return asset?h(Fluent.Button,{key:index,as:'a',size:'small',appearance:'subtle',href:asset.dataUrl,download:asset.reference.filename,'aria-label':t.generatedImage},t.downloadImage):null;
});
};
const messageLabels={
attachmentAlt:t.generatedImage,attachmentLoadFailed:t.imageLoadFailed,error:t.error,
toolResult:t.tool,toolCall:name=>t.tool+': '+name,
loadDetails:t.expandMessage,showDetails:t.expandMessage,hideDetails:t.collapseMessage,reloadDetails:t.reloadMessage,loadMoreDetails:t.loadMore,
detailLoadFailed:t.error,noDetails:t.empty,detailTruncated:t.moreMessage,exportFullMessage:t.downloadMessage,
truncated:()=>t.moreMessage,workSteps:count=>t.tool+' · '+count,toolSteps:count=>t.tool+' · '+count,toolInput:t.toolInput,toolOutput:t.toolOutput
};
return h('div',{ref:container,style:{minWidth:0,height:520,maxHeight:'75vh',background:'var(--colorNeutralBackground1)',color:'var(--colorNeutralForeground1)'},role:'log','aria-live':'polite','aria-label':t.title},
h(ThemeProvider,{theme},h(ScopedCssBaseline,{sx:{display:'flex',flexDirection:'column',height:'100%',minWidth:0,containerType:'inline-size',containerName:'memeloop-chat','& > div':{display:'flex',flexDirection:'column',flex:1,minHeight:0,minWidth:0}}},
h(ComposerContext.Provider,{value:{t,disabled:!ready,busy,clear,Fluent}},
h(MemeLoopRuntimeProvider,{adapter},
h(MemeLoopThread,{showTimeline:false,composerComponent:PlaygroundComposer,messageLabels,loadMessageDetail,loadVisibleAttachments,attachmentRevision:String(assetRevision),renderTurnActions,operationErrorMessage:t.error}))))));
}
