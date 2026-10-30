'use strict';
const { randomUUID } = require('node:crypto');

// Responses exist only for the pending authentication operation, never in the vault.
class AuthPrompts {
  constructor(emit, timeoutMs = 120000) { this.emit = emit; this.timeoutMs = timeoutMs; this.pending = new Map(); }
  request(details, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('Authentication cancelled'));
    if (!Array.isArray(details.prompts) || details.prompts.length > 16) return Promise.reject(new Error('Unsupported authentication challenge'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => finish(new Error('Authentication cancelled'));
      const finish = (error, answers) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.emit('auth:dismiss', { id });
        error ? reject(error) : resolve(answers);
      };
      this.pending.set(id, { details, finish });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error('Authentication prompt timed out')), this.timeoutMs);
      this.emit('auth:prompt', { ...details, id });
    });
  }
  answer(id, answers) {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('Authentication prompt has expired');
    if (answers === null) { entry.finish(new Error('Authentication cancelled')); return; }
    if (!Array.isArray(answers) || answers.length !== entry.details.prompts.length || answers.some((v,i) => typeof v !== 'string' || v.length > 8192 || (entry.details.prompts[i].options && !entry.details.prompts[i].options.some(o => o.value === v)))) throw new Error('Invalid authentication response');
    entry.finish(null, answers);
  }
  cancelAll() { for (const entry of [...this.pending.values()]) entry.finish(new Error('Authentication cancelled')); }
}
module.exports = { AuthPrompts };
