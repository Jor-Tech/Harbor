'use strict';
const {randomUUID} = require('node:crypto');

// A tab outlives its SSH connection. Retain a saved-host reference (or transient
// quick-connect configuration), never authentication responses. resolve() reads
// current vault credentials and the jump route for each attempt.
class TerminalSessions {
  constructor(manager, resolve, {delays = [2000, 5000, 10000, 20000, 30000], stableMs = 60000} = {}) {
    this.manager = manager;
    this.resolve = resolve;
    this.delays = delays;
    this.stableMs = stableMs;
    this.tabs = new Map();
    this.emit = manager.emit;
    manager.emit = (name, event) => {
      const tab = this.tabs.get(event.id);
      if (name === 'terminal:status' && tab) {
        if (['error','closed'].includes(event.status)) {
          tab.failure = event;
          if (!tab.pending) this.disconnected(tab, event);
        }
        return;
      }
      if (name === 'auth:prompt') {
        const authenticating = this.tabs.get(event.connectionId);
        if (authenticating?.pending) this.publish(authenticating, 'authenticating');
      }
      this.emit(name, event);
    };
    // Lock, suspend, import, and app shutdown all use this same cancellation path.
    const closeAll = manager.closeAll.bind(manager);
    manager.closeAll = () => { for (const id of [...this.tabs.keys()]) this.close(id); closeAll(); };
  }

  publish(tab, status, extra = {}) {
    tab.status = status;
    const event = {id:tab.id, status, autoReconnect:tab.autoReconnect, attempt:tab.attempt,
      maxAttempts:this.delays.length, pending:tab.pending, error:undefined, reason:undefined,
      nextRetryAt:undefined, exhausted:false, ...extra};
    tab.event = event;
    this.emit('terminal:status', event);
  }

  async open(reference, local = false) {
    const tab = {id:randomUUID(), reference, local, autoReconnect:false, attempt:0, epoch:0, pending:false};
    this.tabs.set(tab.id, tab);
    await this.attempt(tab, true);
    if (this.tabs.get(tab.id) !== tab) throw new Error('Connection was cancelled');
    return {id:tab.id, label:tab.label, ...tab.event};
  }

  async attempt(tab, initial = false) {
    const epoch = ++tab.epoch;
    const current = () => this.tabs.get(tab.id) === tab && epoch === tab.epoch;
    tab.pending = true;
    tab.failure = null;
    this.publish(tab, initial ? 'connecting' : 'reconnecting');
    try {
      const config = tab.local ? null : await this.resolve(tab.reference);
      if (!current()) return;
      // Leave full-screen mode and reset terminal input modes without erasing scrollback.
      if (!initial) this.emit('terminal:data', {id:tab.id, data:'\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\r\n\x1b[0m\x1b[33m[Harbor: starting a new session — previous commands are not replayed]\x1b[0m\r\n'});
      const result = tab.local ? await this.manager.local(tab.id)
        : await this.manager.connect(config.host, config.credential, config.route, tab.id);
      if (!current()) return;
      tab.label = result.label;
      tab.connectedAt = Date.now();
      tab.pending = false;
      this.publish(tab, 'connected', {label:tab.label});
    } catch (error) {
      if (!current()) return;
      tab.pending = false;
      if (initial) { this.tabs.delete(tab.id); throw error; }
      this.disconnected(tab, tab.failure || {status:'error', error:error.message, retryable:false});
    } finally {
      tab.pending = false;
      if (this.tabs.get(tab.id) === tab && epoch !== tab.epoch) this.publish(tab, 'closed', {reason:'cancelled'});
    }
  }

  disconnected(tab, event) {
    if (tab.connectedAt && Date.now() - tab.connectedAt >= this.stableMs) tab.attempt = 0;
    tab.connectedAt = null;
    if (!tab.local && tab.autoReconnect && event.retryable && tab.attempt < this.delays.length) {
      const delay = this.delays[tab.attempt];
      this.publish(tab, 'waiting', {error:event.error, nextRetryAt:Date.now()+delay, reason:'transport'});
      clearTimeout(tab.timer);
      tab.timer = setTimeout(() => { tab.timer = null; tab.attempt++; void this.attempt(tab); }, delay);
    } else {
      this.publish(tab, event.status, {error:event.error, reason:event.reason,
        exhausted:!!(tab.autoReconnect && event.retryable && tab.attempt >= this.delays.length)});
    }
  }

  get(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('Terminal tab is no longer available');
    return tab;
  }

  reconnect(id) {
    const tab = this.get(id);
    if (tab.pending || tab.status === 'connected') throw new Error('Terminal is already connected or connecting');
    clearTimeout(tab.timer); tab.timer = null; tab.attempt = 0;
    return this.attempt(tab);
  }

  setAutoReconnect(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid reconnect preference');
    const tab = this.get(id);
    if (tab.local) throw new Error('Automatic reconnect is only available for SSH');
    tab.autoReconnect = enabled;
    if (!enabled && ['waiting','reconnecting','authenticating'].includes(tab.status)) this.cancel(id);
    else this.publish(tab, tab.status, tab.event ? {...tab.event, autoReconnect:enabled} : {});
  }

  cancel(id) {
    const tab = this.get(id);
    ++tab.epoch;
    clearTimeout(tab.timer); tab.timer = null;
    // Suppress the underlying close event while stopping an attempt or a timer.
    const pending = tab.pending;
    tab.pending = true;
    this.manager.close(id);
    tab.pending = pending;
    this.publish(tab, pending ? 'cancelling' : 'closed', {reason:'cancelled'});
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.cancel(id);
    this.tabs.delete(id);
    tab.reference = null;
  }
}
module.exports = {TerminalSessions};
