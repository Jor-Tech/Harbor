'use strict';
const {randomUUID}=require('node:crypto');
const os=require('node:os');
const {withMetadata}=require('./entity-metadata.cjs');
const path=require('node:path');
const {resolveHost,resolveRoute}=require('./host-model.cjs');
const SIMPLE=new Set(['hostname','user','port','identityagent','proxyjump']);
const BLOCKING=new Set(['proxycommand','canonicalizehostname']);
function words(input){
 const out=[];let word='',quoted=false,started=false;
 for(let i=0;i<input.length;i++){
  const c=input[i];
  if(c==='\\'&&i+1<input.length&&/[\s#"\\]/.test(input[i+1])){word+=input[++i];started=true;continue;}
  if(c==='"'){quoted=!quoted;started=true;continue;}
  if(c==='#'&&!quoted)break;
  if(/\s/.test(c)&&!quoted){if(started){out.push(word);word='';started=false}}else{word+=c;started=true}
 }
 if(quoted)throw new Error('Unclosed double quote');if(started)out.push(word);return out;
}
function matches(pattern,alias){const re=new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i');return re.test(alias)}
function applies(patterns,alias){return patterns.some(p=>!p.startsWith('!')&&matches(p,alias))&&!patterns.some(p=>p.startsWith('!')&&matches(p.slice(1),alias))}
function parseConfig(text,{home=os.homedir(),source='SSH config'}={}){
 if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw new Error('SSH config must be a text file up to 1 MiB');
 if(text.includes('\0'))throw new Error('SSH config must be plain text');
 const blocks=[{patterns:['*'],options:[]}],diagnostics=[],aliases=new Map();let current=blocks[0];
 for(const [index,raw] of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
  if(!raw.trim()||raw.trim().startsWith('#'))continue;
  const match=/^\s*([^\s=]+)\s*(?:=\s*)?(.*)$/.exec(raw),line=index+1;
  const key=match[1].toLowerCase();let values;
  try{values=words(match[2])}catch(e){throw new Error(`Line ${line}: ${e.message}`)}
  if(!values.length)throw new Error(`Line ${line}: ${key} needs a value`);
  if(key==='host'){
   current={patterns:values,options:[]};blocks.push(current);
   for(const alias of values)if(!/[!*?]/.test(alias)&&!aliases.has(alias.toLowerCase())){
    if(alias.length>200||/[\s\0]/.test(alias))throw new Error(`Line ${line}: invalid host alias`);
    aliases.set(alias.toLowerCase(),{alias,line});
   }
  }else if(key==='match'){
   current=null;diagnostics.push({line,directive:'Match',message:'Conditional Match sections are skipped; no commands are executed. Review hosts affected by these conditions.'});
  }else if(current){current.options.push({key,values,line})}
 }
 if(aliases.size>1000)throw new Error('Import up to 1,000 named hosts at a time');
 const entries=[];
 for(const {alias,line} of aliases.values()){
  const options={},warnings=[],blocked=[];
  const warn=(o,message)=>warnings.push({line:o.line,directive:o.key,message});
  for(const block of blocks){if(!applies(block.patterns,alias))continue;for(const o of block.options){
   if(SIMPLE.has(o.key)){
    if(options[o.key])continue;
    if(o.values.length!==1){blocked.push(`Line ${o.line}: ${o.key} needs one value`);continue;}options[o.key]=o;
   }else if(o.key==='identityfile')warn(o,'Private key files are not read or copied. Choose an existing vault key or SSH agent below, or configure authentication after import.');
   else if(o.key==='include')warn(o,'Included files are not read. Import each file separately and review any defaults or routes it provided.');
   else if(BLOCKING.has(o.key)&&!['none','no'].includes(o.values[0].toLowerCase()))blocked.push(`Line ${o.line}: ${o.key} changes the connection route and cannot be imported.`);
   else warn(o,'This option is not imported. Review its effect before connecting in Harbor.');
  }}
  const value=key=>options[key]?.values[0];
  const address=(value('hostname')||alias).replace(/%%|%h|%n/g,t=>t==='%%'?'%':alias),port=value('port')===undefined?22:Number(value('port'));
  if(!address||address.length>253||/[\s\0%]/.test(address))blocked.push('HostName contains unsupported tokens or an invalid address.');
  if(!Number.isInteger(port)||port<1||port>65535)blocked.push('Port must be between 1 and 65535.');
  const host={label:alias,address,port,username:value('user')||'',sshConfigAlias:alias,agentProvider:'none',groupId:'',keyId:'',color:'blue'};
  const agent=value('identityagent');
  if(agent&&agent!=='none'){
   if(['SSH_AUTH_SOCK','$SSH_AUTH_SOCK'].includes(agent))host.agentProvider='system';
   else if(!/[%$]/.test(agent)&&(path.isAbsolute(agent)||agent.startsWith('~/')||agent.startsWith('\\\\.\\pipe\\'))){host.agentProvider='custom';host.agentSocket=agent.startsWith('~/')?path.join(home,agent.slice(2)):agent;}
   else warnings.push({line:options.identityagent.line,directive:'identityagent',message:'This agent path cannot be expanded. Choose an SSH agent explicitly.'});
  }
  let jump=value('proxyjump');
  if(jump==='none')jump=undefined;
  if(jump&&(!aliases.has(jump.toLowerCase())||/[,@:\[\]]/.test(jump))){blocked.push('ProxyJump must name one alias in this file. Multi-hop lists and inline endpoints need manual setup.');jump=undefined;}
  entries.push({id:randomUUID(),alias,line,host,jump,warnings,blocked});
 }
 // Global diagnostics stay visible even when a file contains no named aliases.
 const reported=new Set(entries.flatMap(e=>e.warnings.map(w=>w.line)));
 for(const block of blocks)for(const o of block.options)if(!SIMPLE.has(o.key)&&!reported.has(o.line)){
  diagnostics.push({line:o.line,directive:o.key,message:'Not imported. Wildcard sections supply defaults only; they do not create hosts.'});reported.add(o.line);
 }
 return {source,entries,diagnostics};
}
function duplicateIds(data,host){return data.hosts.filter(item=>{
 const h=resolveHost(data,item);return (item.sshConfigAlias||item.label).toLowerCase()===host.label.toLowerCase()||
 (h.address?.toLowerCase()===host.address.toLowerCase()&&Number(h.port||22)===host.port&&(h.username||'')===host.username);
}).map(h=>h.id)}
function previewConfig(text,data,options){const preview=parseConfig(text,options);for(const e of preview.entries)e.duplicates=duplicateIds(data,e.host).map(id=>({id,label:data.hosts.find(h=>h.id===id).label}));return preview;}
function applyImport(preview,data,selections,{allowDuplicates=false,acknowledgeWarnings=false}={}){
 if(!Array.isArray(selections)||!selections.length||selections.length>1000)throw new Error('Choose at least one host');
 const ids=new Set(),selected=[];
 for(const choice of selections){
  const entry=preview.entries.find(e=>e.id===choice.id);
  if(!entry||ids.has(choice.id))throw new Error('Invalid import selection');ids.add(choice.id);
  if(entry.blocked.length)throw new Error(`Cannot import ${entry.alias}: ${entry.blocked.join(' ')}`);
  if((entry.warnings.length||preview.diagnostics.length)&&!acknowledgeWarnings)throw new Error('Review and acknowledge the unsupported options first');
  if(duplicateIds(data,entry.host).length&&!allowDuplicates)throw new Error('Duplicates detected. Refresh the preview or explicitly allow additional copies.');
  const host=withMetadata({...entry.host,id:randomUUID()});
  if(choice.auth&&choice.auth!=='config'){
   if(choice.auth.startsWith('key:')){const keyId=choice.auth.slice(4);if(!data.keys.some(k=>k.id===keyId))throw new Error('Selected vault key no longer exists');host.keyId=keyId;host.agentProvider='none';delete host.agentSocket;}
   else if(['none','system','1password'].includes(choice.auth)){host.agentProvider=choice.auth;host.keyId='';delete host.agentSocket;}
   else throw new Error('Invalid authentication choice');
  }
  selected.push({entry,host});
 }
 const aliases=new Map(selected.map(s=>[s.entry.alias.toLowerCase(),s.host]));
 for(const {entry,host} of selected)if(entry.jump){
  const jump=aliases.get(entry.jump.toLowerCase())||data.hosts.find(h=>(h.sshConfigAlias||h.label).toLowerCase()===entry.jump.toLowerCase());
  if(!jump)throw new Error(`Also select jump host “${entry.jump}”, or import it first.`);host.jumpHostId=jump.id;
 }
 const result={...data,hosts:[...data.hosts,...selected.map(s=>s.host)]};for(const {host} of selected)resolveRoute(result,host);
 return result;
}
module.exports={parseConfig,previewConfig,applyImport};
