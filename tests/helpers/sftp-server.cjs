const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Server,utils}=require('ssh2');
const {generateKeyPairSync}=require('node:crypto');
function serveSftp(sftp, root, control = {}) {
  const status = utils.sftp.STATUS_CODE;
  const handles = new Map();
  let nextHandle = 0;
  const local = remote => path.join(root, path.posix.normalize('/' + remote));
  const fail = (id, error) => sftp.status(id, error.code === 'ENOENT' ? status.NO_SUCH_FILE : status.FAILURE);
  const handle = item => {
    const key = String(++nextHandle);
    handles.set(key, item);
    return Buffer.from(key);
  };
  const attributes = stat => ({ mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid,
    atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  sftp.on('error', () => {});
  // Advertise and implement the OpenSSH atomic-rename extension in this fixture.
  const original=sftp._protocol.channelData.bind(sftp._protocol);
  sftp._protocol.channelData=(channel,packet)=>{
    if(control.posixRename!==false&&channel===sftp.outgoing.id&&packet.length===9&&packet[4]===2){
      const name=Buffer.from('posix-rename@openssh.com'),version=Buffer.from('1');
      const ext=Buffer.alloc(8+name.length+version.length);ext.writeUInt32BE(name.length,0);name.copy(ext,4);ext.writeUInt32BE(1,4+name.length);version.copy(ext,8+name.length);
      packet=Buffer.concat([packet,ext]);packet.writeUInt32BE(packet.length-4,0);
    }
    return original(channel,packet);
  };
  sftp.on('RENAME',async(id,source,target)=>{
    control.operations?.push({operation:'rename',source,target});
    try{
      // SFTP v3 RENAME must fail if the target exists, unlike fs.rename on POSIX.
      try{await fs.lstat(local(target));sftp.status(id,status.FAILURE);return}catch(error){if(error.code!=='ENOENT')throw error;}
      await fs.rename(local(source),local(target));sftp.status(id,status.OK);
    }catch(error){fail(id,error);}
  });
  sftp.on('SETSTAT',(id,remote,attrs)=>fs.chmod(local(remote),attrs.mode).then(()=>sftp.status(id,status.OK),e=>fail(id,e)));
  sftp.on('FSETSTAT',(id,value,attrs)=>handles.get(value.toString()).file.chmod(attrs.mode).then(()=>sftp.status(id,status.OK),e=>fail(id,e)));
  sftp.on('EXTENDED',(id,name,data)=>{
    if(name!=='posix-rename@openssh.com'||control.posixRename===false){sftp.status(id,status.OP_UNSUPPORTED);return;}
    const n=data.readUInt32BE(0),source=data.subarray(4,4+n).toString(),m=data.readUInt32BE(4+n),target=data.subarray(8+n,8+n+m).toString();
    control.operations?.push({operation:'posix-rename',source,target});
    if(control.renameFailure){sftp.status(id,control.renameFailure);return;}
    fs.rename(local(source),local(target)).then(()=>sftp.status(id,status.OK),e=>fail(id,e));
  });

  sftp.on('REALPATH', (id, remote) => sftp.name(id, [{ filename: path.posix.resolve('/', remote), longname: '', attrs: {} }]));
  for (const operation of ['STAT', 'LSTAT']) {
    sftp.on(operation, (id, remote) => fs[operation === 'STAT' ? 'stat' : 'lstat'](local(remote))
      .then(stat => sftp.attrs(id, attributes(stat)), error => fail(id, error)));
  }
  sftp.on('OPENDIR', (id, remote) => fs.readdir(local(remote), { withFileTypes: true }).then(async entries => {
    const names = await Promise.all(entries.map(async entry => ({ filename: entry.name, longname: entry.name, attrs: attributes(await fs.lstat(path.join(local(remote), entry.name))) })));
    sftp.handle(id, handle({ names }));
  }).catch(error => fail(id, error)));
  sftp.on('READDIR', async (id, value) => {
    if(control.listingGate) await control.listingGate;
    const entry = handles.get(value.toString());
    if (entry.names.length) { sftp.name(id, entry.names); entry.names = []; }
    else sftp.status(id, status.EOF);
  });
  sftp.on('OPEN', (id, remote, flags, attrs) => fs.open(local(remote), flags & 2 ? (flags & 32 ? 'wx' : 'w') : 'r', attrs.mode || 0o600)
    .then(file => sftp.handle(id, handle({ file })), error => fail(id, error)));
  sftp.on('FSTAT', (id, value) => handles.get(value.toString()).file.stat()
    .then(stat => sftp.attrs(id, attributes(stat)), error => fail(id, error)));
  sftp.on('READ', (id, value, offset, length) => {
    const buffer = Buffer.alloc(length);
    handles.get(value.toString()).file.read(buffer, 0, length, offset).then(({ bytesRead }) => {
      if (bytesRead) sftp.data(id, buffer.subarray(0, bytesRead));
      else sftp.status(id, status.EOF);
    }, error => fail(id, error));
  });
  sftp.on('WRITE', (id, value, offset, data) => handles.get(value.toString()).file.write(data, 0, data.length, offset)
    .then(() => sftp.status(id, status.OK), error => fail(id, error)));
  sftp.on('CLOSE', async (id, value) => {
    const entry = handles.get(value.toString());
    handles.delete(value.toString());
    if (entry?.file) await entry.file.close();
    sftp.status(id, status.OK);
  });
  for (const [operation, method] of [['REMOVE', 'unlink'], ['RMDIR', 'rmdir'], ['MKDIR', 'mkdir']]) {
    sftp.on(operation, (id, remote) => fs[method](local(remote)).then(() => sftp.status(id, status.OK), error => fail(id, error)));
  }
  sftp.on('close', () => { for (const entry of handles.values()) if (entry.file) entry.file.close().catch(() => {}); });
}


async function createServer(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-files-server-')),clients=new Set(),attempts=[],control={listingGate:null};
 const hostKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
 const server=new Server({hostKeys:[hostKey]},client=>{clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',()=>{});client.on('authentication',ctx=>{attempts.push({method:ctx.method,username:ctx.username});if(ctx.method==='password'&&ctx.username==='test'&&ctx.password==='fixture-password')ctx.accept();else ctx.reject(['password'])});client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',a=>a());session.on('window-change',a=>a?.());session.on('shell',a=>{const stream=a();stream.on('error',()=>{});stream.write('BATCH_SSH_READY\r\n');stream.on('data',d=>stream.write(d))});session.on('sftp',a=>serveSftp(a(),root,control))}))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {root,port:server.address().port,attempts,control,close:async()=>{for(const c of clients)c.end();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true})}};
}
module.exports={serveSftp,createServer};
