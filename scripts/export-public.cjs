'use strict';
// Export only reviewed, tracked project files. Never copy .git or local profiles.
const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');

const rootFiles=new Set(['.gitignore','README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','index.html','vite.config.mjs']);
const directories=['.github/workflows/','assets/','build/','electron/','src/','scripts/','tests/'];
const documents=new Set(['Harbor-MCP-guide-en.pdf','images/harbor-workspace.png','backup-management.md','backup-retention.md','desktop-previews.md','desktop-releases.md','mcp-agent-guide.md','mcp.md','user-guide.md','validation.md','vault-protection.md','vault-recovery.md']);
function include(name,version){return rootFiles.has(name)||directories.some(prefix=>name.startsWith(prefix))||documents.has(name.startsWith('docs/')?name.slice(5):'')||name===`docs/releases/${version}.md`}
async function exportPublic({root,destination}){
 root=path.resolve(root);destination=path.resolve(destination);
 const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 const names=tracked.filter(name=>include(name,version)).sort();
 for(const name of [...rootFiles,`docs/releases/${version}.md`])if(!names.includes(name))throw new Error(`Required public file is not tracked: ${name}`);
 // Fail before creating any export if an included file or ancestor is a symlink.
 for(const name of names){
  if(path.isAbsolute(name)||name.split('/').some(p=>p==='..'||p==='.git'))throw new Error('Unsafe export path');
  let current=root;const parts=name.split('/');
  for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!(i===parts.length-1?stat.isFile():stat.isDirectory()))throw new Error(`Export requires regular files and directories: ${name}`)}
 }
 await fs.mkdir(destination,{recursive:false}); // Never overwrite an existing candidate.
 const files=[];
 for(const name of names){const source=path.join(root,name),target=path.join(destination,name),bytes=await fs.readFile(source);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx',mode:(await fs.stat(source)).mode&0o777});files.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})}
 return {version,files,excluded:tracked.filter(name=>!names.includes(name)).sort()};
}
module.exports={include,exportPublic};
if(require.main===module){
 const destination=process.argv[2];if(!destination){console.error('Usage: node scripts/export-public.cjs <new-directory>');process.exitCode=1}
 else exportPublic({root:path.resolve(__dirname,'..'),destination}).then(async manifest=>{await fs.writeFile(path.resolve(destination)+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});console.log(`Exported ${manifest.files.length} files without Git history; ${manifest.excluded.length} internal/historical files excluded.`)}).catch(error=>{console.error(error.message);process.exitCode=1});
}
