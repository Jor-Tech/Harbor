'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {LocalMcpServer,endpoint}=require('../electron/mcp/local-server.cjs');
test('local transport rejects unauthenticated and oversized clients without opening TCP',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-'));const server=new LocalMcpServer({dir,authenticate:()=>{throw new Error('Denied')}});
 try{await server.start();assert.equal(server.server.address(),endpoint(dir));
  if(process.platform!=='win32')assert.equal((await fs.stat(endpoint(dir))).mode&0o777,0o600);
  for(const bytes of ['{"clientId":"wrong"}\n','x'.repeat(262145)]){await new Promise(resolve=>{const s=net.connect(endpoint(dir),()=>s.write(bytes));s.on('error',()=>{});s.resume();s.once('close',resolve);});}
 }finally{await server.stop();await fs.rm(dir,{recursive:true,force:true});}
});
