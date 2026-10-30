'use strict';
// ssh2 1.17.0 drops the server's partial-success/method list in its agent path.
// Keep the correction reproducible across npm ci and packaging. Fail closed if
// the upstream file changes; this must be reviewed when upgrading ssh2.
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const file = require.resolve('ssh2/lib/client');
const source = fs.readFileSync(file, 'utf8');
const before = '        USERAUTH_FAILURE: (p, authMethods, partialSuccess) => {\n';
const after = before + `          // Harbor: preserve agent partial authentication before advancing.
          curPartial = partialSuccess;
          curAuthsLeft = authMethods;
          if (partialSuccess) {
            curAuth.keyAlgos = undefined;
            return tryNextAuth();
          }
`;
const original = source.includes(after) ? source.replace(after, before) : source;
if (require('ssh2/package.json').version !== '1.17.0'
    || createHash('sha256').update(original).digest('hex') !== 'edd3484daa9d942bc5a6412edc9cf11f85df40b2db10b07877bbfe694beac7f4') {
  throw new Error('ssh2 changed; review the Harbor agent MFA correction before building');
}
if (source === original) fs.writeFileSync(file, original.replace(before, after));
