'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');

const targets = {
  'linux-x64': version => [`Harbor-${version}-linux-amd64.deb`, `Harbor-${version}-linux-x86_64.AppImage`],
  'win32-x64': version => [`Harbor-${version}-win-x64.exe`],
  'darwin-x64': version => [`Harbor-${version}-mac-x64.dmg`, `Harbor-${version}-mac-x64.zip`],
  'darwin-arm64': version => [`Harbor-${version}-mac-arm64.dmg`, `Harbor-${version}-mac-arm64.zip`],
};

function validateTag(tag, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) || tag !== `v${version}`) {
    throw new Error('Release tag must exactly match v + package.json version');
  }
}

async function prepare({input, output, version, commit, notes}) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('A full source commit is required');
  const assets = new Map(), builds = [], seen = new Set();
  for (const dir of await fs.readdir(input, {withFileTypes:true})) {
    if (!dir.isDirectory()) throw new Error('Expected one artifact directory per platform');
    const root = path.join(input, dir.name);
    const build = JSON.parse(await fs.readFile(path.join(root,'BUILD.json'),'utf8'));
    const key = `${build.platform}-${build.arch}`;
    if (!targets[key] || seen.has(key) || build.version !== version || build.commit !== commit || build.publisherSigned !== false || build.notarized !== false) throw new Error('Unexpected or inconsistent build identity');
    seen.add(key); builds.push(build);
    const names = targets[key](version);
    const sums = new Map();
    for (const line of (await fs.readFile(path.join(root,'SHA256SUMS.txt'),'utf8')).trim().split('\n')) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
      if (!match || sums.has(match[2])) throw new Error('Invalid checksum manifest');
      sums.set(match[2], match[1]);
    }
    if (sums.size !== names.length || (await fs.readdir(root)).length !== names.length + 2) throw new Error('Unexpected release assets');
    for (const name of names) {
      const source=path.join(root,name), stat=await fs.lstat(source);
      if (!stat.isFile() || stat.size === 0) throw new Error('Invalid installer');
      const bytes=await fs.readFile(source), hash=createHash('sha256').update(bytes).digest('hex');
      if (sums.get(name) !== hash || assets.has(name)) throw new Error('Installer checksum mismatch');
      assets.set(name,{source,hash});
    }
  }
  if (seen.size !== Object.keys(targets).length) throw new Error('All four desktop builds are required');
  // Do not leave stale installers from a prior attempt in the upload directory.
  await fs.mkdir(output,{recursive:true});
  if ((await fs.readdir(output)).length) throw new Error('Release output directory must be empty');
  const names=[...assets.keys()].sort();
  for (const name of names) await fs.copyFile(assets.get(name).source,path.join(output,name));
  await fs.writeFile(path.join(output,'SHA256SUMS.txt'),names.map(name=>`${assets.get(name).hash}  ${name}`).join('\n')+'\n');
  await fs.writeFile(path.join(output,'BUILDS.json'),JSON.stringify({version,commit,builds},null,2)+'\n');
  await fs.writeFile(path.join(output,'RELEASE-NOTES.md'),notes);
  return names;
}

async function main() {
  const version=require('../package.json').version, tag=process.env.GITHUB_REF_NAME;
  validateTag(tag,version);
  const notes=await fs.readFile(path.join(__dirname,'..','docs','releases',`${version}.md`),'utf8');
  if (!notes.trim()) throw new Error('Release notes are required');
  if (process.argv[2]==='validate') return;
  if (process.argv[2]==='prepare') return prepare({input:'release-input',output:'release-assets',version,commit:process.env.GITHUB_SHA,notes});
  if (process.argv[2]!=='publish') throw new Error('Choose validate, prepare or publish');
  if (process.env.GITHUB_REPOSITORY!=='Jor-Tech/Harbor') throw new Error('Unexpected release repository');
  const gh=args=>execFileSync('gh',args,{stdio:'inherit'});
  // A failed upload leaves a draft, never a half-published release. Delete that
  // draft before rerunning; published assets are never silently overwritten.
  gh(['release','create',tag,'--repo',process.env.GITHUB_REPOSITORY,'--verify-tag','--draft','--title',`Harbor ${version}`,'--notes-file','release-assets/RELEASE-NOTES.md',...(version.includes('-')?['--prerelease']:[])]);
  const assets=(await fs.readdir('release-assets')).filter(name=>name!=='RELEASE-NOTES.md').sort();
  gh(['release','upload',tag,...assets.map(name=>path.join('release-assets',name)),'--repo',process.env.GITHUB_REPOSITORY]);
  gh(['release','edit',tag,'--draft=false','--repo',process.env.GITHUB_REPOSITORY]);
}

module.exports={prepare,validateTag,targets};
if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
