'use strict';
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const env = {...process.env};
if(process.argv.includes('--packaged')) {
  const executable = process.platform==='win32' ? 'win-unpacked/Harbor.exe'
    : process.platform==='darwin' ? `mac${process.arch==='arm64'?'-arm64':''}/Harbor.app/Contents/MacOS/Harbor`
    : 'linux-unpacked/harbor-terminal';
  env.HARBOR_EXECUTABLE=path.resolve('preview',executable);
  fs.accessSync(env.HARBOR_EXECUTABLE);
}
for(const script of ['mcp-smoke.cjs','mcp-auth-smoke.cjs','mcp-permissions-smoke.cjs','mcp-full-approval-smoke.cjs','mcp-clients-smoke.cjs','mcp-management-smoke.cjs','mcp-host-rights-smoke.cjs','smoke.cjs','auth-smoke.cjs','batch-smoke.cjs','routing-smoke.cjs','terminal-smoke.cjs','session-restore-smoke.cjs','command-palette-smoke.cjs','import-smoke.cjs','sync-smoke.cjs','hosts-smoke.cjs','release-smoke.cjs','recovery-smoke.cjs','protection-smoke.cjs','backup-management-smoke.cjs','retention-smoke.cjs','ux-smoke.cjs','mcp-approval-ux-smoke.cjs','mcp-approval-matrix-smoke.cjs']) {
  const result=spawnSync(process.execPath,[path.join(__dirname,script)],{env,stdio:'inherit',timeout:180000});
  if(result.error)console.error(result.error);
  if(result.status!==0)process.exit(result.status||1);
}
