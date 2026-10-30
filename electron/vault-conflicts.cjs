'use strict';
const collections=['hosts','groups','keys','snippets','forwardings','workspaces'];
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value)}
const equal=(a,b)=>canonical(a)===canonical(b);
function items(data){
 const result=new Map();
 for(const collection of collections)for(const item of data[collection])result.set(JSON.stringify([collection,item.id]),{collection,id:item.id,value:item});
 for(const collection of ['settings','knownHosts'])for(const [id,value] of Object.entries(data[collection]))result.set(JSON.stringify([collection,id]),{collection,id,value});
 result.set(JSON.stringify(['history','all']),{collection:'history',id:'all',value:data.history});
 for(const [id,value] of Object.entries(data))if(!['version','history','settings','knownHosts',...collections].includes(id))result.set(JSON.stringify(['other',id]),{collection:'other',id,value});
 return result;
}
const publicFields=new Set(['label','address','hostname','username','port','groupId','parentId','jumpHostId','keyId','agentProvider','agentSocket','agentFingerprint','favorite','color','tags','description','type','hostId','localPort','remotePort','remoteHost','listenPort','destinationHost','destinationPort','theme','fontSize','autoLockMinutes','fingerprint','algorithm','sshConfigAlias','createdAt','updatedAt','hostsHomeView','hostSort','hostSortDirection']);
function display(value,name){
 if(value===undefined)return 'Not present';
 if(/password|passphrase|privatekey|command/i.test(name))return value?'Hidden value (set)':'Not set';
 if(publicFields.has(name)&&['string','number','boolean'].includes(typeof value))return String(value).slice(0,1000);
 if(Array.isArray(value))return `${value.length} entries`;
 if(value===null)return 'Not set';
 return 'Set (contents hidden)';
}
function fields(a,b,collection,id){
 if(collection==='history')return [{name:'Entries',local:`${a?.length||0} entries`,remote:`${b?.length||0} entries`}];
 const result=[];
 function visit(x,y,prefix='',depth=0){
  if(equal(x,y))return;
  if(depth<5&&((x&&typeof x==='object'&&!Array.isArray(x))||(y&&typeof y==='object'&&!Array.isArray(y)))){
   for(const key of new Set([...Object.keys(x&&typeof x==='object'?x:{}),...Object.keys(y&&typeof y==='object'?y:{})]))if(key!=='id')visit(x?.[key],y?.[key],prefix?prefix+'.'+key:key,depth+1);
  }else result.push({name:prefix||collection,local:display(x,prefix.split('.').at(-1)||collection),remote:display(y,prefix.split('.').at(-1)||collection)});
 }
 visit(a,b,collection==='settings'?id:collection==='knownHosts'&&(typeof a==='string'||typeof b==='string')?'fingerprint':'');return result.length?result:[{name:'Metadata',local:'Updated',remote:'Updated'}];
}
function compareData(local,remote){
 const a=items(local),b=items(remote),rows=[];
 for(const key of new Set([...a.keys(),...b.keys()])){
  const left=a.get(key),right=b.get(key);if(equal(left?.value,right?.value))continue;
  const item=left||right;
  rows.push({key,collection:item.collection,label:String(item.collection==='history'?'Connection history':left?.value?.label||right?.value?.label||item.id).slice(0,200),localPresent:!!left,remotePresent:!!right,fields:fields(left?.value,right?.value,item.collection,item.id)});
 }
 return rows;
}
function mergeChoices(local,remote,selections){
 const rows=compareData(local,remote);
 if(!Array.isArray(selections)||selections.length!==rows.length)throw new Error('Choose a version for every changed item');
 const rowKeys=new Set(rows.map(r=>r.key)),choices=new Map();for(const s of selections){if(!s||typeof s.key!=='string'||!['local','remote'].includes(s.side)||choices.has(s.key)||!rowKeys.has(s.key))throw new Error('Invalid conflict choice');choices.set(s.key,s.side)}
 const a=items(local),b=items(remote),merged=clone(local);
 for(const c of collections)merged[c]=[];merged.settings={};merged.knownHosts={};
 for(const key of new Set([...a.keys(),...b.keys()])){
  const entry=(choices.get(key)==='remote'?b:a).get(key);if(!entry){const old=a.get(key)||b.get(key);if(old.collection==='other')delete merged[old.id];continue;}
  const {collection,id,value}=entry;
  if(collection==='history')merged.history=clone(value);
  else if(collection==='other')merged[id]=clone(value);
  else if(collection==='settings'||collection==='knownHosts')Object.defineProperty(merged[collection],id,{value:clone(value),enumerable:true,writable:true,configurable:true});
  else merged[collection].push(clone(value));
 }
 validateReferences(merged,local,remote);return merged;
}
function referenceIssues(data){
 const issues=new Map(),hosts=new Set(data.hosts.map(h=>h.id)),keys=new Set(data.keys.map(k=>k.id));
 const missing=(source,id,type,target,message)=>issues.set(JSON.stringify([source,id,type,target]),message);
 for(const collection of ['hosts','groups'])for(const entry of data[collection]){const id=entry.keyId||entry.defaults?.auth?.keyId;if(id&&!keys.has(id))missing(collection,entry.id,'key',id,`“${entry.label}” needs a key omitted by your choices. Keep that key or choose the other version.`)}
 for(const rule of data.forwardings)if(!hosts.has(rule.hostId))missing('forwardings',rule.id,'host',rule.hostId,`Forwarding “${rule.label}” needs a host omitted by your choices.`);
 const visit=(node,workspace)=>{if(node.type==='split'){visit(node.first,workspace);visit(node.second,workspace)}else if(!node.local&&!hosts.has(node.hostId))missing('workspaces',workspace.id,'host',node.hostId,`Workspace “${workspace.label}” needs a host omitted by your choices.`)};
 for(const workspace of data.workspaces)visit(workspace.layout,workspace);return issues;
}
function validateReferences(merged,local,remote){
 // Existing orphaned forwarding/workspace entries are already permitted by
 // older vaults. Reject new broken combinations, without trapping their owner.
 const prior=new Set([...referenceIssues(local).keys(),...referenceIssues(remote).keys()]);
 for(const [key,message] of referenceIssues(merged))if(!prior.has(key))throw new Error(message);
}

module.exports={compareData,mergeChoices,equal};
