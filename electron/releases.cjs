'use strict';
// Keep external navigation fixed to the project's releases. Neither renderer
// input nor remote release metadata can provide an arbitrary external URL.
const REPOSITORY='Jor-Tech/Harbor';
const RELEASES_URL=`https://github.com/${REPOSITORY}/releases`;
function releaseInfo({version,platform,arch,packaged}) {
  const names={linux:'Linux',win32:'Windows',darwin:'macOS'};
  return {version,platform:names[platform]||platform,arch,packaged,preview:version.includes('-')};
}
module.exports={REPOSITORY,RELEASES_URL,releaseInfo};
