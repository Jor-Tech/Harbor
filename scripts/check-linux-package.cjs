'use strict';
// Inspect the DEB itself: unpacked-app tests do not exercise desktop integration.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const metadata = require('../package.json');
(async () => {
  const deb = process.argv[2] || path.join('preview', `Harbor-${metadata.version}-linux-amd64.deb`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-deb-check-'));
  try {
    execFileSync('dpkg-deb', ['--extract', deb, dir]);
    const desktop = await fs.readFile(path.join(dir, 'usr/share/applications', metadata.desktopName), 'utf8');
    assert.match(desktop, /^Exec=\/opt\/Harbor\/harbor-terminal(?: %U)?$/m);
    assert.match(desktop, /^Icon=harbor-terminal$/m);
    assert.match(desktop, /^StartupWMClass=harbor$/m);
    await fs.access(path.join(dir, 'opt/Harbor/harbor-terminal'));
    const resources=path.join(dir,'opt/Harbor/resources');
    assert.equal((await fs.readFile(path.join(resources,'package-type'),'utf8')).trim(),'deb');
    const updateConfig=await fs.readFile(path.join(resources,'app-update.yml'),'utf8');
    assert.match(updateConfig,/^provider: generic$/m);
    assert.match(updateConfig,/^url: https:\/\/github\.com\/Jor-Tech\/Harbor\/releases\/latest\/download\/$/m);
    assert.match(updateConfig,/^updaterCacheDirName: \S+$/m);
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const png = await fs.readFile(path.join(dir, `usr/share/icons/hicolor/${size}x${size}/apps/harbor-terminal.png`));
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
    console.log('DEB launcher, executable, update configuration, package identity and eight standard icon sizes verified.');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
