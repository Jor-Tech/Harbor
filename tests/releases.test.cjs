'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {prepare,validateTag,targets}=require('../scripts/release.cjs');

const version='0.3.0-preview.8',commit='a'.repeat(40);
async function artifacts(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-release-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'input'),output=path.join(root,'output');await fs.mkdir(input);
  for (const [key,names] of Object.entries(targets)) {
    const [platform,arch]=key.split('-'),dir=path.join(input,key);await fs.mkdir(dir);
    await fs.writeFile(path.join(dir,'BUILD.json'),JSON.stringify({version,commit,platform,arch,publisherSigned:false,notarized:false}));
    const sums=[];
    for(const name of names(version)){const bytes=Buffer.from(name);await fs.writeFile(path.join(dir,name),bytes);sums.push(createHash('sha256').update(bytes).digest('hex')+'  '+name)}
    await fs.writeFile(path.join(dir,'SHA256SUMS.txt'),sums.join('\n')+'\n');
  }
  return {input,output,version,commit,notes:'Release notes'};
}
test('release tag must identify the exact package version',()=>{
  validateTag('v'+version,version);validateTag('v1.0.0','1.0.0');
  for(const tag of ['main','v0.2.0','v'+version+'-other'])assert.throws(()=>validateTag(tag,version));
  assert.throws(()=>validateTag('v../notes','../notes'));
});
test('release preparation combines exactly four verified builds and seven installers',async t=>{
  const args=await artifacts(t),names=await prepare(args);assert.equal(names.length,7);
  const result=JSON.parse(await fs.readFile(path.join(args.output,'BUILDS.json'),'utf8'));assert.equal(result.builds.length,4);assert.equal(result.commit,commit);
  assert.equal((await fs.readFile(path.join(args.output,'SHA256SUMS.txt'),'utf8')).trim().split('\n').length,7);
  await assert.rejects(prepare(args),/empty/);
});
test('release preparation rejects missing platforms, tampered installers, wrong commit and unexpected files',async t=>{
  for (const change of ['missing','tampered','commit','extra']) {
    const args=await artifacts(t),dir=path.join(args.input,'linux-x64');
    if(change==='missing')await fs.rm(dir,{recursive:true});
    if(change==='tampered')await fs.appendFile(path.join(dir,targets['linux-x64'](version)[0]),'bad');
    if(change==='commit'){const file=path.join(dir,'BUILD.json'),build=JSON.parse(await fs.readFile(file));build.commit='b'.repeat(40);await fs.writeFile(file,JSON.stringify(build))}
    if(change==='extra')await fs.writeFile(path.join(dir,'unexpected.exe'),'extra');
    await assert.rejects(prepare(args));await assert.rejects(fs.access(args.output));
  }
});
