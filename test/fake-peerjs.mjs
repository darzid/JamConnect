// In-memory PeerJS replacement for tests: the surface JamConnect uses
// (Peer open/connection/error, DataConnection open/data/close, JSON serialisation)
// over an ordered, reliable channel with a configurable one-way latency.
// Timers come from the caller so tests can run on a virtual clock.

export function createFakePeerJS({ setTimeout, now, latencyMs = () => 10 }) {
  const registry = new Map();

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev, arg) { for (const fn of this._h[ev] || []) fn(arg); }
  }

  class FakeConn extends Emitter {
    constructor(remoteId, metadata) {
      super();
      this.peer = remoteId;
      this.metadata = metadata;
      this.open = false;
      this.other = null;
      this.sent = [];
      this._lastDelivery = 0;
    }

    send(obj) {
      if (!this.open) return;
      this.sent.push(obj);
      const data = JSON.parse(JSON.stringify(obj));
      // Ordered, reliable channel: never deliver before the previous message.
      const at = Math.max(now() + latencyMs(), this._lastDelivery);
      this._lastDelivery = at;
      setTimeout(() => { if (this.other.open) this.other.emit('data', data); }, at - now());
    }

    close() {
      if (!this.open) return;
      this.open = false;
      this.other.open = false;
      setTimeout(() => { this.emit('close'); this.other.emit('close'); }, 0);
    }
  }

  class FakePeer extends Emitter {
    constructor(id) {
      super();
      this.id = id;
      this.destroyed = false;
      registry.set(id, this);
      setTimeout(() => this.emit('open', id), 0);
    }

    connect(target, opts = {}) {
      const remote = registry.get(target);
      const mine = new FakeConn(target, opts.metadata);
      const theirs = new FakeConn(this.id, opts.metadata);
      mine.other = theirs;
      theirs.other = mine;
      setTimeout(() => {
        if (!remote) { this.emit('error', { type: 'peer-unavailable', message: 'peer unavailable' }); return; }
        remote.emit('connection', theirs);
        setTimeout(() => { mine.open = theirs.open = true; theirs.emit('open'); mine.emit('open'); }, latencyMs());
      }, 0);
      return mine;
    }

    reconnect() {}

    destroy() {
      this.destroyed = true;
      registry.delete(this.id);
    }
  }

  return { Peer: FakePeer, registry };
}
