'use strict';
const path=require('node:path'),{policy,text,object,allows}=require('./policy.cjs');
const RULES={harbor_connect:'connect',harbor_exec:'exec',harbor_list_files:'files:list',harbor_read_file:'files:read',harbor_disconnect:'disconnect'};
const fileTool=tool=>['harbor_list_files','harbor_read_file','harbor_write_file'].includes(tool);
const absolute=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!value.includes('\0')&&path.posix.isAbsolute(value)&&path.posix.normalize(value)===value;
function rules(client,input,{allowAllCommands=false,allowFileWrites=false,allowFileScopes=false,headless=false}={}){
 policy(client);if(!Array.isArray(input)||input.length>20)throw new Error('At most 20 rules per client.');
 return input.map(value=>{
  object(value,['tool','hostId','command','path',...(allowAllCommands||allowFileWrites||allowFileScopes||headless?['scope']:[]),...(headless?['binding','destination']:[])]);
  const right=RULES[value.tool]||((headless||allowFileWrites)&&value.tool==='harbor_write_file'?'files:write':null);
  if(!right||!allows(client,right,value.hostId))throw new Error('Rule exceeds client permissions.');text(value.hostId,128);
  const r={tool:value.tool,hostId:value.hostId};
  if(value.scope!==undefined){
   if(value.tool==='harbor_exec'&&(allowAllCommands||headless)&&value.scope==='all-commands'&&value.command===undefined)r.scope=value.scope;
   else if(((headless||allowFileScopes)&&fileTool(value.tool)||allowFileWrites&&value.tool==='harbor_write_file')&&['directory','all-paths'].includes(value.scope))r.scope=value.scope;
   else throw new Error('Invalid rule scope.');
  }
  if(value.tool==='harbor_exec'&&!r.scope)r.command=text(value.command,16384);else if(value.command!==undefined)throw new Error('Unexpected command.');
  if(fileTool(value.tool)&&r.scope!=='all-paths'){r.path=text(value.path,2048);if(!absolute(r.path))throw new Error('Use a normalized absolute path.');if(r.scope==='directory'&&r.path!=='/'&&r.path.endsWith('/'))throw new Error('Remove the trailing slash from the folder path.');}
  else if(value.path!==undefined)throw new Error('Unexpected path.');
  if(headless&&(value.binding!==undefined||value.destination!==undefined)){
   if(!/^[a-f0-9]{64}$/.test(value.binding))throw new Error('Invalid SSH account binding.');
   r.binding=value.binding;r.destination=text(value.destination,4096);
  }
  return r;
 });
}
function matchesRule(r,tool,hostId,args){
 if(r.tool!==tool||r.hostId!==hostId)return false;
 if(tool==='harbor_exec')return r.scope==='all-commands'||r.command===args.command;
 if(fileTool(tool)){
  if(!absolute(args.path))return false;
  if(r.scope==='all-paths')return true;
  if(r.scope==='directory')return args.path===r.path||args.path.startsWith(r.path==='/'?'/':r.path+'/');
  return r.path===args.path;
 }
 return true;
}
function matches(client,tool,hostId,args,binding){
 return rules(client,client.automations||[],{headless:true}).some(r=>
  // Legacy exact rules keep their existing behavior until reviewed and saved. New scopes and writes always bind an SSH account.
  (r.binding?r.binding===binding:!r.scope&&r.tool!=='harbor_write_file')&&matchesRule(r,tool,hostId,args));
}
function savedApprovals(client,input){
 if(!Array.isArray(input)||input.length>20)throw new Error('At most 20 saved approvals per client.');
 const ids=new Set();return input.map(value=>{object(value,['id','rule','binding','destination']);if(!/^[a-f0-9-]{36}$/.test(value.id)||ids.has(value.id)||!/^[a-f0-9]{64}$/.test(value.binding))throw new Error('Invalid saved approval.');ids.add(value.id);return {id:value.id,rule:rules(client,[value.rule],{allowAllCommands:true,allowFileWrites:true,allowFileScopes:true})[0],binding:value.binding,destination:text(value.destination,4096)};});
}
module.exports={rules,matches,matchesRule,savedApprovals};
