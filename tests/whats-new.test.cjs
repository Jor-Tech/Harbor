'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const semver=require('semver');
const {WhatsNew}=require('../electron/whats-new.cjs');
const notes=[
 {version:'1.0.0',meaningful:true},
 {version:'1.0.1',meaningful:false},
 {version:'1.1.0-beta.1',meaningful:true},
 {version:'1.1.0',meaningful:true},
 {version:'1.1.1',meaningful:false},
 {version:'2.0.0',meaningful:true},
];
async function fixture(t,saved){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-whats-new-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 if(saved)await fs.writeFile(path.join(dir,'whats-new.json'),JSON.stringify(saved));
 const open=async(version,packaged=true)=>{const news=new WhatsNew({dir,version,packaged,notes});await news.load();return news};
 return {dir,open};
}
test('first installed launch establishes a durable baseline without showing history',async t=>{
 const {dir,open}=await fixture(t);const news=await open('1.0.0');assert.equal(news.snapshot().autoShow,false);assert.deepEqual(news.snapshot().pending,[]);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'whats-new.json'),'utf8')),{automatic:true,seenVersion:'1.0.0'});
 assert.equal((await open('1.0.0')).snapshot().autoShow,false);
});
test('maintenance is quiet; skipped meaningful releases are combined and acknowledged across restarts',async t=>{
 const {open}=await fixture(t,{automatic:true,seenVersion:'1.0.0'});
 const patch=await open('1.0.1');assert.equal(patch.snapshot().autoShow,false);assert.equal(patch.snapshot().pending.length,1);
 const news=await open('1.1.1');assert.equal(news.snapshot().autoShow,true);
 assert.deepEqual(news.snapshot().pending.map(n=>n.version),['1.1.1','1.1.0','1.1.0-beta.1','1.0.1']);
 assert(!news.snapshot().releases.some(n=>n.version==='2.0.0'),'Future notes stay hidden');
 await news.acknowledge();assert.equal((await open('1.1.1')).snapshot().autoShow,false);
 assert.equal((await open('2.0.0')).snapshot().autoShow,true);
});
test('automatic display is optional and manual reading still acknowledges releases',async t=>{
 const {open}=await fixture(t,{automatic:true,seenVersion:'1.0.0'});const news=await open('1.1.0');
 await news.configure({automatic:false});const restarted=await open('1.1.0');assert.equal(restarted.snapshot().autoShow,false);assert(restarted.snapshot().releases.length>0);
 await restarted.acknowledge();await restarted.configure({automatic:true});assert.equal(restarted.snapshot().autoShow,false);
 for(const args of [null,{},[],{automatic:'false'},{automatic:true,seenVersion:'9.0.0'}])await assert.rejects(()=>restarted.configure(args));
});
test('downgrades do not rewind acknowledgments; development builds do not announce or establish a baseline',async t=>{
 const {dir,open}=await fixture(t);const dev=await open('1.0.0',false);assert.equal(dev.snapshot().autoShow,false);await assert.rejects(fs.stat(path.join(dir,'whats-new.json')));
 const current=await open('1.1.0');await current.acknowledge();const older=await open('1.0.0');await older.acknowledge();assert.equal((await open('1.1.0')).snapshot().autoShow,false);
 assert.equal((await open('2.0.0',false)).snapshot().autoShow,false);
});
test('failed acknowledgment leaves the update unread; broken preferences never block startup',async t=>{
 const {dir,open}=await fixture(t,{automatic:true,seenVersion:'1.0.0'});const news=await open('1.1.0');
 await fs.rm(path.join(dir,'whats-new.json'));await fs.mkdir(path.join(dir,'whats-new.json'));
 await assert.rejects(news.acknowledge());assert.equal(news.snapshot().autoShow,true);
 const broken=await open('1.1.0');assert(broken.snapshot().error);assert.equal(broken.snapshot().autoShow,false);assert(broken.snapshot().releases.length>0);
});
test('bundled release highlights are valid, concise and include the running release',()=>{
 const catalog=require('../electron/release-notes.json'),versions=new Set();
 for(const note of catalog){assert(semver.valid(note.version));assert(!versions.has(note.version));versions.add(note.version);assert.equal(typeof note.meaningful,'boolean');assert.match(note.date,/^\d{4}-\d{2}-\d{2}$/);assert.equal(new Date(note.date).toISOString().slice(0,10),note.date);assert(note.title);assert(note.items.length>0&&note.items.length<=5);assert(note.items.every(item=>typeof item==='string'&&item.length>0&&item.length<300))}
 assert(versions.has(require('../package.json').version),'Add highlights and choose meaningful true/false when preparing a release');
});
