'use strict';
const {utils} = require('ssh2');

// ssh2 1.17 can occasionally serialize a generated key that its own parser
// rejects. Never return that key to the UI or persist it in a vault.
function generateKeyPair(type = 'ed25519', options = {}, generate = utils.generateKeyPairSync) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pair = generate(type, options);
    const privateKey = utils.parseKey(pair.private, options.passphrase);
    const publicKey = utils.parseKey(pair.public);
    if (!(privateKey instanceof Error) && !(publicKey instanceof Error)
        && privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) return pair;
  }
  throw new Error('Could not generate a valid SSH key. Please try again.');
}
module.exports = {generateKeyPair};
