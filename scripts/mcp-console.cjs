#!/usr/bin/env node
'use strict';
// A local review client. It never reads vault credentials or saves command history.
const path=require('node:path'),readline=require('node:readline');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
(async()=>{
 if(process.argv.length!==4||process.argv[2]!=='--credential'||!path.isAbsolute(process.argv[3]))throw new Error('Usage: node scripts/mcp-console.cjs --credential /absolute/client.json');
 const client=new Client({name:'Harbor review console',version:'1.0.0'});let sessionId;
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(__dirname,'../electron/mcp/bridge.cjs'),'--credential',process.argv[3]]}));
 const lines=readline.createInterface({input:process.stdin,output:process.stdout,terminal:!!process.stdin.isTTY,historySize:0});
 const quit=async()=>{lines.close();await client.close()};process.once('SIGINT',()=>{void quit()});
 const help='tools | hosts | sessions | connect HOST_ID | exec EXACT COMMAND | ls /path | read /path | write /path :: content | disconnect | quit';
 console.log(help);lines.setPrompt('Harbor MCP> ');if(!lines.closed)lines.prompt();
 try{for await(const line of lines){const input=line.trim();if(input==='quit')break;let name,args={};
  if(input==='tools'){console.log(JSON.stringify(await client.listTools(),null,2));if(!lines.closed)lines.prompt();continue;}
  if(input==='hosts')name='harbor_list_hosts';else if(input==='sessions')name='harbor_list_sessions';
  else if(input.startsWith('connect ')){name='harbor_connect';args={hostId:input.slice(8)}}
  else if(input.startsWith('exec ')){name='harbor_exec';args={sessionId,command:input.slice(5)}}
  else if(input.startsWith('ls ')){name='harbor_list_files';args={sessionId,path:input.slice(3)}}
  else if(input.startsWith('read ')){name='harbor_read_file';args={sessionId,path:input.slice(5)}}
  else if(input.startsWith('write ')){const n=input.indexOf(' :: ');if(n>=0){name='harbor_write_file';args={sessionId,path:input.slice(6,n),content:input.slice(n+4)}}}
  else if(input==='disconnect'){name='harbor_disconnect';args={sessionId}}
  if(!name){console.log(help);if(!lines.closed)lines.prompt();continue;}
  try{const result=await client.callTool({name,arguments:args},undefined,{timeout:330000});console.log(JSON.stringify(result,null,2));if(!result.isError&&name==='harbor_connect')sessionId=JSON.parse(result.content[0].text).sessionId;if(!result.isError&&name==='harbor_disconnect')sessionId=undefined;}
  catch{console.log('Request failed or access was revoked. Check Harbor; restart this console after resuming MCP.');}
  if(!lines.closed)lines.prompt();
 }}finally{await quit()}
})().catch(error=>{console.error(error.message);process.exitCode=1});
