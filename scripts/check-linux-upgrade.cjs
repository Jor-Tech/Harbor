'use strict';
// Runs only on an ephemeral GitHub-hosted Linux runner, never on a user's laptop.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {_electron:electron}=require('playwright');
const expected=require('../tests/fixtures/upgrade-preview7-expected.json');
const version=require('../package.json').version;
const repo='Jor-Tech/Harbor',executable='/opt/Harbor/harbor-terminal';
const run=(file,args,options={})=>execFileSync(file,args,{stdio:'inherit',...options});
const capture=(file,args)=>run(file,args,{stdio:'pipe',encoding:'utf8'}).trim();
const debVersion=v=>v.replace('-','~');
const older=(a,b)=>spawnSync('dpkg',['--compare-versions',debVersion(a),'lt',debVersion(b)]).status===0;
async function probe(profile,expectedVersion,fontSize,saveSize) {
  const app=await electron.launch({executablePath:executable,args:['--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:profile}});
  try {
    assert.equal(await app.evaluate(({app})=>app.getVersion()),expectedVersion);
    const page=await app.firstWindow();page.setDefaultTimeout(15000);
    await page.getByLabel('Vault password',{exact:true}).fill('upgrade-fixture-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
    const data=await page.evaluate(()=>window.harbor.invoke('vault:read'));
    const {effectiveHosts,groupDefaults,...stored}=data;delete stored.settings.syncFolder;delete stored.settings.autoSync;
    assert.deepEqual(stored,{...expected,settings:{...expected.settings,fontSize}});
    await page.evaluate(fontSize=>window.harbor.invoke('settings:save',{fontSize}),saveSize);
  } finally {await app.close()}
}
(async()=>{
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Linux')throw new Error('Installer checks require an ephemeral GitHub Linux runner');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-installed-upgrade-'));
  try {
    const profile=path.join(dir,'profile');await fs.mkdir(profile);
    await fs.copyFile(path.join(__dirname,'../tests/fixtures/upgrade-preview7-vault.json'),path.join(profile,'vault.hbr'));
    const device={autoSync:false};await fs.writeFile(path.join(profile,'device.json'),JSON.stringify(device));
    const releases=JSON.parse(capture('gh',['api',`repos/${repo}/releases?per_page=100`]));
    const candidates=releases.filter(r=>!r.draft&&/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(r.tag_name)&&older(r.tag_name.slice(1),version)&&r.assets?.some(a=>a.name===`Harbor-${r.tag_name.slice(1)}-linux-amd64.deb`&&a.state==='uploaded')).sort((a,b)=>older(a.tag_name.slice(1),b.tag_name.slice(1))?1:-1);
    const baseline=candidates[0];let fontSize=14;
    if(baseline) {
      const previous=baseline.tag_name.slice(1),name=`Harbor-${previous}-linux-amd64.deb`;
      run('gh',['release','download',baseline.tag_name,'--repo',repo,'--pattern',name,'--dir',dir]);
      assert.equal(capture('dpkg-deb',['--field',path.join(dir,name),'Package']),'harbor-terminal');
      run('sudo',['apt-get','install','-y',path.join(dir,name)]);
      await probe(profile,previous,14,16);fontSize=16;
    } else console.log('No older published DEB is available: checking first installation with the frozen preview.7 profile.');
    const deb=path.resolve('preview',`Harbor-${version}-linux-amd64.deb`);
    assert.equal(capture('dpkg-deb',['--field',deb,'Package']),'harbor-terminal');
    run('sudo',['apt-get','install','-y',deb]);
    await probe(profile,version,fontSize,18);await probe(profile,version,18,18);
    const vaultBytes=await fs.readFile(path.join(profile,'vault.hbr'));
    run('sudo',['apt-get','remove','-y','harbor-terminal']);
    assert.deepEqual(await fs.readFile(path.join(profile,'vault.hbr')),vaultBytes);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile,'device.json'),'utf8')),device);
    console.log(`PASS: installed Linux app ${baseline?'upgrade from '+baseline.tag_name:'first install'}, vault preservation, restart and uninstall preservation.`);
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error.message);process.exitCode=1});
