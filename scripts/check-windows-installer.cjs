'use strict';
// Compile production NSIS hooks on any host; execute real NTFS checks on Windows.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {getMakeNsisPath,getNsisPluginsPath}=require('app-builder-lib/out/toolsets/windows');
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000,...options});if(r.error||r.status!==0)throw new Error(`${command} failed (exit ${r.status}, signal ${r.signal||'none'}): ${r.error?.message||r.stdout+'\n'+r.stderr}`);return r.stdout}
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-installer-check-'));let denied;
 try{
  const tool=await getMakeNsisPath(),plugins=await getNsisPluginsPath(),templates=path.resolve('node_modules/app-builder-lib/templates/nsis'),resources=path.resolve('build');
  const compile=async(source,output)=>{
   const file=path.join(dir,path.basename(output)+'.nsi');await fs.writeFile(file,source);
   // Compiler stdin gives the script stable paths on all hosts.
   const outputText=run(tool.path,['-V2','-INPUTCHARSET','UTF8','-'],{input:`!addplugindir /x86-unicode "${plugins}/x86-unicode"\n!addincludedir "${resources}"\n!addincludedir "${templates}/include"\n!define OUTPUT "${output}"\n${source}`,env:{...process.env,...tool.env}});
   if(/unknown variable/i.test(outputText))throw new Error(outputText);
  };
  // Compile the actual customization with MUI callbacks and the builder's own
  // directory-normalization function, rather than a JavaScript policy replica.
  const assisted=await fs.readFile(path.join(templates,'assistedInstaller.nsh'),'utf8');
  const normalization=assisted.match(/Function instFilesPre\b[\s\S]*?FunctionEnd/);assert(normalization,'Builder directory normalization hook changed');
  const hooks=`Unicode true\n!include MUI2.nsh\n!include UAC.nsh\n!include StrContains.nsh\nVar installMode\n!define APP_FILENAME Harbor\n!include installer.nsh\nName "Harbor hook compilation"\nOutFile "\${OUTPUT}"\nRequestExecutionLevel user\n!insertmacro MUI_PAGE_DIRECTORY\n${normalization[0]}\n!insertmacro customPageAfterChangeDir\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_LANGUAGE English\n!insertmacro MUI_LANGUAGE Dutch\n!insertmacro customHeader\nFunction .onInit\nStrCpy $installMode CurrentUser\n!insertmacro customInit\nFunctionEnd\nSection\nFileOpen $0 "$EXEDIR\\installation-started.txt" w\nFileWrite $0 "started"\nFileClose $0\nSectionEnd\n`;
  await compile(hooks,path.join(dir,'hooks.exe'));
  await compile(await fs.readFile('tests/fixtures/installer/destination-check.nsi','utf8'),path.join(dir,'checks.exe'));
  console.log('Production NSIS hooks and destination checks compiled.');
  if(process.platform!=='win32'){console.log('Windows runtime checks require a Windows runner; compilation only on this host.');return}
  await fs.mkdir(path.join(dir,'writable'));await fs.writeFile(path.join(dir,'occupied'),'existing file must stay unchanged');
  denied=path.join(dir,'denied');await fs.mkdir(denied);
  run('icacls.exe',[denied,'/deny','*S-1-1-0:(W)']);
  let checkError;
  try{run(path.join(dir,'checks.exe'),['/S'])}catch(error){checkError=error}
  // NSIS writes to this report, not stdout. Read it even when the executable
  // fails, before cleanup removes the evidence needed to diagnose Windows CI.
  const report=await fs.readFile(path.join(dir,'results.txt'),'utf8').catch(error=>{
   if(checkError)throw new Error(`${checkError.message}\nNo destination report: ${error.message}`);
   throw error;
  });
  console.log(report.trim());
  if(checkError)throw checkError;
  assert.equal(report.trim().split(/\r?\n/).length,10);assert(!report.includes('FAIL'));
  const protectedTarget=path.join(process.env.ProgramW6432||process.env.ProgramFiles,'Harbor');
  const blocked=spawnSync(path.join(dir,'hooks.exe'),['/S',`/D=${protectedTarget}`],{timeout:30000,encoding:'utf8',windowsVerbatimArguments:true});
  assert.ifError(blocked.error);assert.equal(blocked.status,5,'Silent protected destination must exit before installation');
  await assert.rejects(fs.access(path.join(dir,'installation-started.txt')));
  run(path.join(dir,'hooks.exe'),['/S',`/D=${path.join(dir,'writable')}`],{windowsVerbatimArguments:true});
  assert.equal(await fs.readFile(path.join(dir,'installation-started.txt'),'utf8'),'started');
  console.log('Silent hook checks passed: blocked before installation, allowed for a writable target.');
  assert.deepEqual(await fs.readdir(path.join(dir,'writable')),[],'Checks must not leave probes or create target directories');
  assert.equal(await fs.readFile(path.join(dir,'occupied'),'utf8'),'existing file must stay unchanged');
 }finally{
  if(denied)run('icacls.exe',[denied,'/remove:d','*S-1-1-0']);
  await fs.rm(dir,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1});
