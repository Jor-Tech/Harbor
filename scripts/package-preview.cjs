'use strict';
// Preview builds deliberately use no publisher credentials and never publish.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
delete process.env.CSC_LINK;
delete process.env.WIN_CSC_LINK;
const {build, Platform, archFromString} = require('electron-builder');
build({
  targets: Platform.current().createTarget(null, archFromString(process.arch)),
  publish: 'never',
  config: {
    directories: {output: 'preview'},
    mac: {identity: '-', hardenedRuntime: false, notarize: false},
    win: {signExecutable: false},
  },
}).catch(error => {console.error(error);process.exitCode=1;});
