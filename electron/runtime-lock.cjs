'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
function acquireRuntime(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'harbor-runtime.lock'),nonce=randomUUID();
 for(let i=0;i<3;i++){
  let fd;try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));fs.closeSync(fd);return ()=>{try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.nonce===nonce)fs.unlinkSync(file);}catch{}};}
  catch(error){if(fd!==undefined)fs.closeSync(fd);if(error.code!=='EEXIST')throw error;
   const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>4096)throw new Error('Invalid Harbor runtime lock.');let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch{throw new Error('Harbor runtime lock is incomplete. Close Harbor before removing it.');}
   if(!Number.isInteger(saved.pid)||saved.pid<1)throw new Error('Invalid Harbor runtime owner.');let alive=true;try{process.kill(saved.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;}
   if(alive)throw new Error('Harbor is already running with this data directory. Close it before starting another GUI or headless process.');
   if(fs.statSync(file).ino!==stat.ino)continue;fs.unlinkSync(file);
  }
 }
 throw new Error('Harbor runtime ownership changed. Try again.');
}
module.exports={acquireRuntime};
