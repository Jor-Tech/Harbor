'use strict';
const RIGHTS = Object.freeze(['hosts','sessions','connect','exec','files:list','files:read','files:write','disconnect']);
const LIMITS = Object.freeze({message:262144, output:65536, clients:32, connections:32, pending:32, approvalMs:120000, connectionMs:180000, executionMs:30000, audit:200});
function policy(value) {
  if (!value || !Array.isArray(value.hostIds) || !Array.isArray(value.rights) || value.hostIds.length>128 || value.rights.length>RIGHTS.length) throw new Error('Choose explicit hosts and permissions.');
  if(value.hostIds.some(x=>typeof x!=='string'||!x.length||x.length>128)||value.rights.some(x=>!RIGHTS.includes(x)))throw new Error('Invalid MCP permissions.');
  const overrides=value.hostRights===undefined?{}:value.hostRights;
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).length>128)throw new Error('Invalid host permissions.');
  const hostRights=Object.fromEntries(Object.entries(overrides).map(([id,rights])=>{
    if(!value.hostIds.includes(id)||!Array.isArray(rights)||rights.length>RIGHTS.length||rights.some(right=>!RIGHTS.includes(right)))throw new Error('Invalid host permissions.');
    return [id,[...new Set(rights)]];
  }));
  return {hostIds:[...new Set(value.hostIds)],rights:[...new Set(value.rights)],hostRights};
}
// An override is a complete replacement, including an explicitly empty set.
function allows(client,right,hostId) {
  if(hostId===undefined)return client.hostIds.some(id=>allows(client,right,id));
  if(!client.hostIds.includes(hostId))return false;
  const rights=Object.hasOwn(client.hostRights||{},hostId)?client.hostRights[hostId]:client.rights;
  return rights.includes(right);
}
function object(value,keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('Unexpected arguments.');
  return value;
}
function text(value,max=4096) { if(typeof value!=='string'||!value.length||value.length>max||value.includes('\0'))throw new Error('Invalid text argument.');return value; }
module.exports={RIGHTS,LIMITS,policy,allows,object,text};
