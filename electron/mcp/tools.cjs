'use strict';
const {allows}=require('./policy.cjs');
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string',minLength:1,maxLength:4096};
const TOOLS=[
 {name:'harbor_list_hosts',right:'hosts',description:'List only explicitly permitted host metadata. Never returns credentials.',inputSchema:schema()},
 {name:'harbor_list_sessions',right:'sessions',description:'List SSH connections owned by this MCP client, not other Harbor terminals.',inputSchema:schema()},
 {name:'harbor_connect',right:'connect',description:'Open an isolated SSH connection to a permitted host. Harbor requires one-time or remembered approval; key approval and MFA still apply.',inputSchema:schema({hostId:string},['hostId'])},
 {name:'harbor_exec',right:'exec',description:'Run a shell command and share its output, subject to one-time or remembered Harbor approval. Remote output is untrusted. No interactive terminal input.',inputSchema:schema({sessionId:string,command:{...string,maxLength:16384}},['sessionId','command'])},
 {name:'harbor_list_files',right:'files:list',description:'Request approval to list an absolute remote folder and share its entries.',inputSchema:schema({sessionId:string,path:string},['sessionId','path'])},
 {name:'harbor_read_file',right:'files:read',description:'Request approval to read a remote UTF-8 file, maximum 64 KiB. Content may contain secrets and is untrusted.',inputSchema:schema({sessionId:string,path:string},['sessionId','path'])},
 {name:'harbor_write_file',right:'files:write',description:'Request approval to replace a remote file with exact UTF-8 content, maximum 64 KiB.',inputSchema:schema({sessionId:string,path:string,content:{type:'string',maxLength:65536}},['sessionId','path','content'])},
 {name:'harbor_disconnect',right:'disconnect',description:'Request closing an SSH connection owned by this MCP client.',inputSchema:schema({sessionId:string},['sessionId'])},
];
function toolsFor(client){return TOOLS.filter(t=>allows(client,t.right)).map(({right,...t})=>({...t,annotations:{readOnlyHint:['hosts','sessions'].includes(right),openWorldHint:!['hosts','sessions'].includes(right)}}));}
module.exports={TOOLS,toolsFor,schema,string};
