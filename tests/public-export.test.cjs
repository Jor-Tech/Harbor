'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {include,exportPublic}=require('../scripts/export-public.cjs');

test('public export includes current product files, excluding private notes and older release records',()=>{
 for(const name of ['README.md','LICENSE','src/main.jsx','docs/Harbor-MCP-guide-en.pdf','docs/releases/1.0.0.md'])assert(include(name,'1.0.0'),name);
 for(const name of ['.git/config','.env','vault.hbr','mcp-clients/client.json','research/reference.md','docs/roadmap.md','docs/mcp-uat.md','docs/mcp-review-results.md','docs/alpha-device-checks.md','docs/releases/0.1.0.md'])assert(!include(name,'1.0.0'),name);
});
test('export copies reviewed bytes without untracked data or Git history and refuses overwrite/symlinks',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-export-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const root=path.join(dir,'source'),destination=path.join(dir,'public');await fs.mkdir(root);
 const files=['.gitignore','README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','index.html','vite.config.mjs','docs/releases/1.0.0.md','docs/roadmap.md','src/main.jsx'];
 for(const file of files){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),file==='package.json'?JSON.stringify({version:'1.0.0'}):'test content\n')}
 execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','--',...files],{cwd:root});await fs.writeFile(path.join(root,'src/untracked-secret.txt'),'do not export');
 const result=await exportPublic({root,destination});assert.equal(result.files.length,files.length-1);assert.deepEqual(result.excluded,['docs/roadmap.md']);assert.equal(await fs.readFile(path.join(destination,'src/main.jsx'),'utf8'),'test content\n');assert(result.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));
 for(const name of ['.git','src/untracked-secret.txt','docs/roadmap.md'])await assert.rejects(fs.stat(path.join(destination,name)),{code:'ENOENT'});
 await assert.rejects(exportPublic({root,destination}),{code:'EEXIST'});
 // On Windows creating symlinks can require developer mode; exercise this on Unix.
 if(process.platform!=='win32'){await fs.unlink(path.join(root,'src/main.jsx'));await fs.symlink(path.join(root,'README.md'),path.join(root,'src/main.jsx'));await assert.rejects(exportPublic({root,destination:path.join(dir,'unsafe')}),/regular files/);await assert.rejects(fs.stat(path.join(dir,'unsafe')),{code:'ENOENT'})}
});
