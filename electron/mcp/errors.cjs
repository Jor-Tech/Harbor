'use strict';
// Only these local messages may cross the MCP boundary. Never forward raw SSH errors.
const messages=Object.freeze({
 REQUEST_DENIED:'Request blocked in Harbor. The action was not executed.',
 APPROVAL_EXPIRED:'The approval request expired. The action was not executed. Submit a new request.',
 REQUEST_CANCELLED:'Request cancelled or MCP access paused. If execution had started, changes may already have occurred.',
 APPROVED_ACTION_FAILED:'The action was approved, but execution failed. Check the SSH connection and server permissions. Changes may already have occurred.',
 ATOMIC_REPLACE_UNSUPPORTED:'The write was approved, but this server does not support safe replacement of an existing file. The existing file was not replaced.',
 REQUEST_FAILED:'The request could not be completed. Check permissions, vault state and the SSH connection in Harbor.'
});
class ActionError extends Error {
 constructor(code){super(messages[code]||messages.REQUEST_FAILED);this.code=Object.hasOwn(messages,code)?code:'REQUEST_FAILED';}
}
const publicError=error=>{const code=error instanceof ActionError?error.code:'REQUEST_FAILED';return {code,message:messages[code]};};
module.exports={ActionError,publicError,messages};
