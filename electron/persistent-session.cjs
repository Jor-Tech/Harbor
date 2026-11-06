'use strict';
// Only Harbor-generated names are accepted, including when restoring a vault.
function validateSessionRef(value) {
  if (typeof value !== 'string' || !/^harbor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('Invalid persistent session reference');
  }
  return value;
}
module.exports = {validateSessionRef};
