'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
(async()=>{
  const version=require('../package.json').version;
  const files=require('./release.cjs').targets[`${process.platform}-${process.arch}`]?.(version).sort();
  if(!files)throw new Error('Unsupported preview platform');
  for(const file of files)await fs.access(path.join('preview',file));
  const lines=[];
  for(const file of files)lines.push(createHash('sha256').update(await fs.readFile(path.join('preview',file))).digest('hex')+'  '+file);
  await fs.writeFile('preview/SHA256SUMS.txt',lines.join('\n')+'\n');
  await fs.writeFile('preview/BUILD.json',JSON.stringify({version:require('../package.json').version,commit:process.env.GITHUB_SHA||null,platform:process.platform,arch:process.arch,publisherSigned:false,notarized:false},null,2)+'\n');
  console.log(lines.join('\n'));
})().catch(error=>{console.error(error);process.exitCode=1});
