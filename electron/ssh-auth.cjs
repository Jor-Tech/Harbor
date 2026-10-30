'use strict';

// Only authentication method names/status are retained, never prompt answers.
function authenticationHandler({username, key, agent, password, ask, fail, isClosed, state}) {
  const attempted = new Set(), completed = new Set();
  let last;
  return (methods, partial, callback) => {
    if (isClosed()) return;
    state.remainingMethods = (methods || []).filter(m => ['publickey','password','keyboard-interactive','hostbased','gssapi-with-mic'].includes(m));
    if (partial && last) {
      completed.add(last);
      state.acceptedFactors = [...completed];
      // A method rejected before an earlier factor may become available now.
      attempted.clear();
      for (const method of completed) attempted.add(method);
    }
    // Some servers omit their method list. Preserve configured credentials as a
    // fallback, but don't solicit an unsaved password unless the server asks.
    const available = method => !attempted.has(method) && (methods?.includes(method === 'agent' ? 'publickey' : method)
      || (methods?.length === 0 && (method === 'publickey' || method === 'agent' || (method === 'password' && password))));
    let next;
    if (!last) next = 'none';
    else if (key && available('publickey')) next = 'publickey';
    else if (agent && available('agent')) next = 'agent';
    else if (available('keyboard-interactive')) next = 'keyboard-interactive';
    else if (available('password')) next = 'password';
    else return false;
    last = next;
    attempted.add(next);
    state.attemptedMethods.push(next);
    if (next === 'publickey') return {type:next, username, key};
    if (next !== 'password') return next;
    if (typeof password === 'string' && password.length) return {type:next, username, password};
    ask({kind:'server-password', name:'Server account password', instructions:'The SSH server requires the password for this account. This is not your SSH key passphrase or 1Password account password.', prompts:[{prompt:'Server account password',echo:false}]})
      .then(([answer]) => { if (!isClosed()) callback({type:'password', username, password:answer}); }, fail);
  };
}

function authenticationFailure(error, state, agent) {
  if (!['client-authentication','agent'].includes(error.level)) return null;
  const signing = agent?.authState;
  let explanation;
  if (error.level === 'agent') explanation = 'The SSH agent could not sign. Check 1Password for an approval request, including its tray icon, and make sure key use is allowed.';
  else if (state.acceptedFactors.includes('agent') || state.acceptedFactors.includes('publickey')) explanation = 'The server accepted the SSH key, but an additional authentication step failed.';
  else if (signing && !signing.signingRequested) explanation = 'The server did not request a signature for the selected key. Check that this exact public-key fingerprint is authorized for the SSH username shown below.';
  else if (signing?.signatureReturned) explanation = 'The SSH agent signed, but the server did not complete authentication. Check the authorized key and server authentication policy.';
  else explanation = 'The server did not complete authentication. Check the username, credentials, and required authentication methods.';
  return {...state, ...(signing || {}), explanation};
}
module.exports = {authenticationHandler, authenticationFailure};
