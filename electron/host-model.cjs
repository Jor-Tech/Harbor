'use strict';
const AUTH_FIELDS=['password','keyId','agentProvider','agentSocket','agentFingerprint','useAgent'];
function groupChain(groups,id){
 const chain=[],seen=new Set();
 while(id){
  if(seen.has(id)||chain.length>=16)throw new Error('Groups cannot contain cycles or exceed 16 levels');
  seen.add(id);const group=groups.find(g=>g.id===id);
  if(!group)throw new Error('Parent group was not found');
  chain.unshift(group);id=group.parentId;
 }
 return chain;
}
function groupDefaults(groups,id){
 const result={port:22,username:'',auth:{agentProvider:'none'}},sources={};
 for(const g of groupChain(groups,id))for(const field of ['port','username','auth']){
  if(g.defaults?.[field]!==undefined){result[field]=g.defaults[field];sources[field]=g.label;}
 }
 return {...result,sources};
}
function resolveHost(data,host){
 const defaults=groupDefaults(data.groups,host.groupId),result={...host};
 for(const field of ['username','port'])if(host.inherit?.[field])result[field]=defaults[field];
 if(host.inherit?.auth){for(const f of AUTH_FIELDS)delete result[f];Object.assign(result,defaults.auth);}
 return result;
}
function resolveRoute(data, host) {
 if(host.jumpHostId!==undefined&&typeof host.jumpHostId!=='string')throw new Error('Invalid jump host');
 const route=[], seen=new Set(host.id?[host.id]:[]);
 let id=host.jumpHostId;
 while(id){
  if(typeof id!=='string')throw new Error('Invalid jump host');
  if(seen.has(id))throw new Error('Jump hosts cannot contain a cycle');
  if(route.length>=8)throw new Error('A route supports at most eight jump hosts');
  seen.add(id);
  const jump=data.hosts.find(h=>h.id===id);
  if(!jump)throw new Error('Jump host not found. Update hosts using it before deleting it.');
  route.unshift(resolveHost(data,jump)); id=jump.jumpHostId;
 }
 return route;
}
function validateGroups(data){
 for(const g of data.groups){
  groupChain(data.groups,g.id);
  const d=g.defaults||{};
  if(d.port!==undefined&&(!Number.isInteger(d.port)||d.port<1||d.port>65535))throw new Error('Group port must be between 1 and 65535');
  if(d.username!==undefined&&typeof d.username!=='string')throw new Error('Invalid group username');
  if(d.auth!==undefined&&(!d.auth||typeof d.auth!=='object'||Array.isArray(d.auth)||Object.keys(d.auth).some(k=>!AUTH_FIELDS.includes(k))))throw new Error('Invalid group credentials');
 }
 for(const h of data.hosts)if(h.groupId)groupChain(data.groups,h.groupId);
}
function deleteGroup(data,id){
 const removed=data.groups.find(g=>g.id===id);if(!removed)return;
 // Preserve the effective settings of directly affected hosts and children.
 for(const h of data.hosts.filter(h=>h.groupId===id))Object.assign(h,resolveHost(data,h),{groupId:removed.parentId||'',inherit:{}});
 for(const g of data.groups.filter(g=>g.parentId===id)){
  const d=groupDefaults(data.groups,g.id);g.defaults={port:d.port,username:d.username,auth:d.auth};g.parentId=removed.parentId||'';
 }
 data.groups=data.groups.filter(g=>g.id!==id);
}
function validateWorkspace(item){
 let count=0;const ids=new Set();
 function visit(node,depth=0){
  if(!node||typeof node!=='object'||depth>8)throw new Error('Invalid workspace layout');
  if(node.type==='split'){
   if(!['horizontal','vertical'].includes(node.direction)||!Number.isFinite(node.ratio)||node.ratio<.15||node.ratio>.85)throw new Error('Invalid workspace split');
   visit(node.first,depth+1);visit(node.second,depth+1);
  }else if(node.type==='pane'){
   if(++count>8||typeof node.id!=='string'||!node.id||ids.has(node.id)||!(node.local===true||typeof node.hostId==='string'&&node.hostId))throw new Error('Invalid workspace pane');
   if(node.sessionRef!==undefined){if(node.local)throw new Error('Local terminals cannot use persistent SSH sessions');require('./persistent-session.cjs').validateSessionRef(node.sessionRef);}
   ids.add(node.id);
  }else throw new Error('Invalid workspace layout');
 }
 visit(item.layout);
}
module.exports={AUTH_FIELDS,groupChain,groupDefaults,resolveHost,resolveRoute,validateGroups,deleteGroup,validateWorkspace};
