// Run with: node --test test/
// Loads jamconnect.js (a classic browser script) into a VM context with a virtual clock,
// an in-memory PeerJS, and minimal Tone.js / DOM stubs. No dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFakePeerJS } from './fake-peerjs.mjs';

const SOURCE = readFileSync(new URL('../jamconnect.js', import.meta.url), 'utf8');

function createClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, interval, args) => {
    const id = ++seq;
    timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, args, interval, seq: id });
    return id;
  };
  return {
    now: () => t,
    setTimeout: (fn, ms, ...args) => add(fn, ms, 0, args),
    setInterval: (fn, ms, ...args) => add(fn, ms, Math.max(1, Number(ms) || 0), args),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const tm of timers.values()) {
          if (tm.at <= end && (!next || tm.at < next.at || (tm.at === next.at && tm.seq < next.seq))) next = tm;
        }
        if (!next) break;
        t = next.at;
        if (next.interval) {
          next.at += next.interval;
          next.seq = ++seq;
        } else {
          timers.delete([...timers].find(([, v]) => v === next)[0]);
        }
        next.fn(...next.args);
      }
      t = end;
    }
  };
}

// Tone.js stand-in: a linear transport on an audio clock that is the virtual clock (seconds).
function createTone(clock, lookAhead = 0.1) {
  const tone = { now: () => clock.now() / 1000 + lookAhead };
  tone.context = { get currentTime() { return clock.now() / 1000; } };
  const rate = () => transport.bpm.value / 60 * transport.PPQ;
  const resolveTime = (time) => {
    if (time === undefined || time === null) return tone.now();
    if (typeof time === 'string' && time.startsWith('+')) return tone.now() + Number(time.slice(1));
    return Number(time);
  };
  const toTicks = (offset) => (typeof offset === 'string' && offset.endsWith('i'))
    ? Number(offset.slice(0, -1))
    : Number(offset) * rate();
  const transport = {
    PPQ: 192,
    bpm: { value: 120 },
    swing: 0,
    starts: [],
    _started: false,
    _startAt: 0,
    _anchorTime: 0,
    _anchorTicks: 0,
    _listeners: {},
    on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; },
    ticksAt(time) {
      if (!this._started || time < this._anchorTime) return this._anchorTicks;
      return this._anchorTicks + (time - this._anchorTime) * rate();
    },
    get state() { return this._started && tone.now() >= this._startAt ? 'started' : 'stopped'; },
    get ticks() { return this.ticksAt(tone.now()); },
    set ticks(value) {
      if (this._started) this._anchorTime = Math.max(tone.now(), this._startAt);
      this._anchorTicks = value;
    },
    get seconds() { return this.ticks / rate(); },
    set seconds(value) { this.ticks = value * rate(); },
    start(time, offset) {
      const at = resolveTime(time);
      this.starts.push({ at, offset });
      this._started = true;
      this._startAt = this._anchorTime = at;
      if (offset !== undefined) this._anchorTicks = toTicks(offset);
      for (const fn of this._listeners.start || []) fn();
      return this;
    },
    stop() {
      this._started = false;
      this._anchorTicks = 0;
      for (const fn of this._listeners.stop || []) fn();
      return this;
    }
  };
  tone.Transport = transport;
  return tone;
}

class FakeElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
    this.className = '';
    this.htmlWrites = [];
    this._text = '';
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return ''; }
  set innerHTML(value) { this.htmlWrites.push(String(value)); this._text = ''; this.children = []; }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  addEventListener() {}
}

function createDocument() {
  const byId = new Map();
  return {
    byId,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement(id));
      return byId.get(id);
    },
    createElement: (tag) => new FakeElement('', tag)
  };
}

function loadJamConnect({ latencyMs = () => 10 } = {}) {
  const clock = createClock();
  const { Peer } = createFakePeerJS({ setTimeout: clock.setTimeout, now: clock.now, latencyMs });
  const document = createDocument();
  const warnings = [];
  const ctx = {
    console: { log() {}, warn: (...a) => warnings.push(a.map(String).join(' ')), error() {} },
    performance: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    URL,
    Peer,
    document,
    navigator: {},
    window: { crypto: globalThis.crypto, location: { href: 'https://jam.test/app/', origin: 'https://jam.test' } },
    Tone: createTone(clock)
  };
  vm.createContext(ctx);
  const api = vm.runInContext(`${SOURCE}\n;({ JamConnector, JamConnectClient })`, ctx, { filename: 'jamconnect.js' });
  return { ...api, clock, ctx, document, warnings, createTone: () => createTone(clock) };
}

async function startSession(env, { guests = 1, permissions = null, hostOptions = {}, guestOptions = {} } = {}) {
  const host = new env.JamConnector('Acid303', env.createTone(), hostOptions);
  const created = host.createHostSession();
  env.clock.advance(1);
  const { sessionId, authToken } = await created;
  if (permissions) host.sendPermissionsUpdate(permissions);
  const joined = [];
  for (let i = 0; i < guests; i++) {
    const guest = new env.JamConnector('Acid303', env.createTone(), guestOptions);
    const joining = guest.joinHost(`${sessionId}:${authToken}`, '', `guest${i}`);
    env.clock.advance(200);
    await joining;
    joined.push(guest);
  }
  return { host, guests: joined };
}

function received(conn, type) {
  return conn.sent.filter(m => m.type === type);
}

// ---------- 1. Trust boundaries ----------

test('host ignores PERMISSIONS_UPDATE sent by a guest', async () => {
  const env = loadJamConnect();
  const { host, guests: [guest] } = await startSession(env);
  const stepUpdates = [];
  host.onPatternStepUpdated = (...args) => stepUpdates.push(args);

  guest.hostConn.send({ type: 'PERMISSIONS_UPDATE', permissions: { syncPattern: true, syncDeviceParameterChange: true } });
  env.clock.advance(50);
  assert.equal(host.permissions.syncPattern, false);
  assert.equal(host.permissions.syncDeviceParameterChange, false);

  guest.sendPatternStepUpdate('bass', 3, { on: true });
  env.clock.advance(50);
  assert.equal(stepUpdates.length, 0, 'guest pattern edit must stay blocked');

  // Guests still accept it from the host.
  host.sendPermissionsUpdate({ syncPattern: true });
  env.clock.advance(50);
  assert.equal(guest.permissions.syncPattern, true);
});

test('CLOCK_SYNC, PEER_LIST and TRANSPORT_HEARTBEAT from a non-host are ignored', async () => {
  const env = loadJamConnect();
  const { host, guests: [guest] } = await startSession(env);
  const peerLists = [];
  host.onPeerConnected = (...args) => peerLists.push(args);

  guest.hostConn.send({ type: 'CLOCK_SYNC', rtt: 999, timeOffset: 5000 });
  guest.hostConn.send({ type: 'PEER_LIST', peers: [{ id: 'x', name: 'spoof' }] });
  guest.hostConn.send({ type: 'TRANSPORT_HEARTBEAT', bpm: 180, seconds: 12, ticks: 4608, hostTime: 0 });
  env.clock.advance(50);
  assert.equal(host.rtt, 0);
  assert.equal(host.timeOffset, 0);
  assert.equal(peerLists.length, 0);
  assert.equal(host.Tone.Transport.state, 'stopped');
  assert.equal(host.Tone.Transport.bpm.value, 120);

  // A guest only trusts its host connection.
  const rtt = guest.rtt;
  guest._routeMessage({ type: 'CLOCK_SYNC', rtt: 999, timeOffset: 5000 }, 'jam-guest-evil');
  guest._routeMessage({ type: 'PERMISSIONS_UPDATE', permissions: { syncPattern: true } }, 'jam-guest-evil');
  assert.equal(guest.rtt, rtt);
  assert.equal(guest.permissions.syncPattern, false);
});

test('FULL_STATE_SYNC from a guest needs the matching permissions', async () => {
  const env = loadJamConnect();
  const { host, guests: [guest] } = await startSession(env);
  const applied = [];
  host.applyFullStateSnapshot = (...args) => applied.push(args);

  guest.broadcast({ type: 'FULL_STATE_SYNC', appName: 'Acid303', snapshot: { bpm: 90 } });
  env.clock.advance(50);
  assert.equal(applied.length, 0);

  host.sendPermissionsUpdate({ syncPattern: true, syncDeviceParameterChange: true, syncMasterSettings: true });
  env.clock.advance(50);
  guest.broadcast({ type: 'FULL_STATE_SYNC', appName: 'Acid303', snapshot: { bpm: 90 } });
  env.clock.advance(50);
  assert.equal(applied.length, 1);
});

test('malformed messages are dropped with a warning, numeric fields are clamped', async () => {
  const env = loadJamConnect();
  const { host, guests: [guest] } = await startSession(env, { permissions: { syncDeviceParameterChange: true } });
  const params = [];
  const pads = [];
  host.onDeviceParameterChanged = (...args) => params.push(args);
  host.onPadTriggered = (...args) => pads.push(args);
  const warningsBefore = env.warnings.length;

  for (const bad of [
    'not json{',
    '[1,2,3]',
    { type: 'NOT_A_TYPE' },
    { type: 42 },
    { type: 'DEVICE_PARAMETER_CHANGES', changes: 'cutoff' },
    { type: 'DEVICE_PARAMETER_CHANGES', changes: [{ value: 1 }] },
    { type: 'DEVICE_PARAMETER_CHANGE', param: 'cutoff', value: 0.5, normalizedValue: 'x' },
    { type: 'TRANSPORT_STATE', state: 'started', bpm: 'fast' },
    { type: 'TRANSPORT_STATE', state: 'started', seconds: { x: 1 } }
  ]) {
    guest.hostConn.send(bad);
  }
  assert.doesNotThrow(() => env.clock.advance(50));
  assert.equal(params.length, 0);
  assert.equal(host.Tone.Transport.state, 'stopped');
  assert.ok(env.warnings.length - warningsBefore >= 9, 'each dropped message logs a warning');

  guest.hostConn.send({ type: 'TRANSPORT_STATE', state: 'bpmchanged', bpm: 100000 });
  guest.hostConn.send({ type: 'PAD_PLAY', appName: 'Acid303', instrument: 'bass', note: 'C2', velocity: 7, delayFromSendMs: 0 });
  guest.hostConn.send({ type: 'DEVICE_PARAMETER_CHANGE', appName: 'Acid303', param: 'cutoff', value: 0.5, normalizedValue: 3 });
  env.clock.advance(50);
  assert.equal(host.Tone.Transport.bpm.value, 400);
  assert.equal(pads[0][3], 1);
  assert.equal(params[0][3], 1);
});

// ---------- 2. XSS ----------

test('peer names are rendered as text, never as HTML', async () => {
  const env = loadJamConnect();
  const client = new env.JamConnectClient('Acid303', env.document.getElementById('app'));
  const evil = '<img src=x onerror=alert(1)>';
  client._updateStatusUI({ status: 'hosting', message: 'Session JAM-TEST', peers: [{ id: 'p1', name: evil, rtt: 12 }] });

  const list = env.document.getElementById('jam-peers-list');
  assert.equal(list.htmlWrites.length, 0, 'the peer list must not be written with innerHTML');
  assert.equal(list.children.length, 2);
  assert.equal(list.children[1].textContent, `${evil} (12ms)`);
  for (const el of env.document.byId.values()) {
    if (el.id === 'app') continue;
    assert.ok(el.htmlWrites.every(html => !html.includes('onerror')), `no remote HTML in #${el.id}`);
  }
});
// ---------- 7. Timing options ----------

test('timing constants are exposed as overridable per-instance options', () => {
  const env = loadJamConnect();
  const defaults = new env.JamConnector('Acid303', env.createTone());
  assert.equal(defaults.timing.startDelaySec, 0.015);
  assert.equal(defaults.timing.paramBufferMs, 0);
  assert.equal(defaults.timing.pingIntervalMs, 10000);

  const tuned = new env.JamConnector('Acid303', env.createTone(), { timing: { startDelaySec: 0.08, paramBufferMs: 30 } });
  assert.equal(tuned.timing.startDelaySec, 0.08);
  assert.equal(tuned.timing.paramBufferMs, 30);
  assert.equal(tuned.timing.pingIntervalMs, 10000);
  assert.equal(defaults.timing.paramBufferMs, 0, 'overrides do not leak into other instances');

  const client = new env.JamConnectClient('Acid303', null, false, { timing: { paramBufferMs: 20 } });
  assert.equal(client.connector.timing.paramBufferMs, 20);
});
// ---------- 3. Parameter path ----------

test('DEVICE_PARAMETER_CHANGES applies every change (and is relayed)', async () => {
  const env = loadJamConnect();
  const { host, guests: [a, b] } = await startSession(env, { guests: 2, permissions: { syncDeviceParameterChange: true } });
  const onHost = [];
  const onB = [];
  host.onDeviceParameterChanged = (...args) => onHost.push(args);
  b.onDeviceParameterChanged = (...args) => onB.push(args);

  a.broadcast({ type: 'DEVICE_PARAMETER_CHANGES', appName: 'Acid303', changes: [
    { param: 'cutoff', value: 800, normalizedValue: 0.4 },
    { param: 'resonance', value: 12, normalizedValue: 0.6 },
    { param: 'decay', value: 0.3, normalizedValue: null }
  ] });
  env.clock.advance(50);
  const expected = [
    ['Acid303', 'cutoff', 800, 0.4],
    ['Acid303', 'resonance', 12, 0.6],
    ['Acid303', 'decay', 0.3, null]
  ];
  assert.deepEqual(onHost, expected);
  assert.deepEqual(onB, expected);
});

test('a burst inside the buffer window becomes exactly one batched message, never an empty one', async () => {
  const env = loadJamConnect();
  const { guests: [guest] } = await startSession(env, { permissions: { syncDeviceParameterChange: true }, guestOptions: { timing: { paramBufferMs: 30 } } });
  const sent = () => guest.hostConn.sent.filter(m => m.type.startsWith('DEVICE_PARAMETER_CHANGE'));

  for (let i = 0; i < 60; i++) {
    guest.sendDeviceParameterChange(['cutoff', 'resonance', 'decay'][i % 3], i, i / 60);
    env.clock.advance(0.4);
  }
  assert.equal(sent().length, 0, 'nothing is sent before the window ends');
  env.clock.advance(30);
  assert.equal(sent().length, 1);
  const [batch] = sent();
  assert.equal(batch.type, 'DEVICE_PARAMETER_CHANGES');
  assert.deepEqual(JSON.parse(JSON.stringify(batch.changes.map(c => [c.param, c.value]))), [['cutoff', 57], ['resonance', 58], ['decay', 59]]);
  assert.equal(batch.changes.find(c => c.param === 'decay').normalizedValue, 59 / 60);

  env.clock.advance(500);
  assert.equal(sent().length, 1, 'no further (empty) batches');
  assert.ok(sent().every(m => m.type !== 'DEVICE_PARAMETER_CHANGES' || m.changes.length > 0));

  // One parameter in a window is sent in the singular form old clients understand.
  for (let i = 0; i < 10; i++) guest.sendDeviceParameterChange('cutoff', i, i / 10);
  env.clock.advance(31);
  assert.equal(sent().length, 2);
  assert.deepEqual({ ...sent()[1] }, { type: 'DEVICE_PARAMETER_CHANGE', appName: 'Acid303', param: 'cutoff', value: 9, normalizedValue: 0.9 });
});

test('with the default window (0) every change is sent immediately, as before', async () => {
  const env = loadJamConnect();
  const { guests: [guest] } = await startSession(env, { permissions: { syncDeviceParameterChange: true } });
  guest.sendDeviceParameterChange('cutoff', 1, 0.1);
  guest.sendDeviceParameterChange('cutoff', 2, 0.2);
  assert.deepEqual(received(guest.hostConn, 'DEVICE_PARAMETER_CHANGE').map(m => m.value), [1, 2]);
});

test('remotely applied changes are not echoed back', async () => {
  const env = loadJamConnect();
  const { host, guests: [guest] } = await startSession(env, { permissions: { syncDeviceParameterChange: true, syncPattern: true } });
  // A typical app: applying a value moves the knob, whose handler sends the change again.
  host.onDeviceParameterChanged = (app, param, value, normalized) => host.sendDeviceParameterChange(param, value, normalized);
  host.onMasterSettingUpdated = (app, setting, value) => host.sendMasterSettingUpdate(setting, value);
  host.onPatternStepUpdated = (app, instrument, step, data) => host.sendPatternStepUpdate(instrument, step, data);
  const hostConnToGuest = host.peers.values().next().value.conn;
  const before = hostConnToGuest.sent.length;

  guest.sendDeviceParameterChange('cutoff', 5, 0.5);
  guest.sendMasterSettingUpdate('delayWet', 0.3);
  guest.sendPatternStepUpdate('bass', 2, { on: true });
  env.clock.advance(50);
  assert.equal(hostConnToGuest.sent.length, before, 'host sent nothing back to the originating guest');
  assert.equal(host.isApplyingRemoteUpdate, false);

  // Local changes still go out.
  host.sendDeviceParameterChange('cutoff', 6, 0.6);
  assert.equal(hostConnToGuest.sent.length, before + 1);
});
// ---------- 4. Start / join timing ----------

const TICK_TOLERANCE = 1; // 1 tick at PPQ 192 / 120 BPM = 2.6 ms

function phaseErrorTicks(env, a, b) {
  const t = env.clock.now() / 1000 + 0.1;
  return Math.abs(a.Tone.Transport.ticksAt(t) - b.Tone.Transport.ticksAt(t));
}

for (const startDelaySec of [0.015, 0.1]) {
  test(`host and guest start together with 30 ms one-way latency (start lead ${startDelaySec * 1000} ms)`, async () => {
    const env = loadJamConnect({ latencyMs: () => 30 });
    const { host, guests: [guest] } = await startSession(env, { hostOptions: { timing: { startDelaySec } } });
    assert.equal(guest.rtt, 60, 'clock sync measured the round trip');

    host.startTransport(120);
    env.clock.advance(300);
    assert.equal(host.Tone.Transport.state, 'started');
    assert.equal(guest.Tone.Transport.state, 'started');
    assert.ok(phaseErrorTicks(env, host, guest) < TICK_TOLERANCE, `phase error ${phaseErrorTicks(env, host, guest)} ticks`);
  });
}

test('a guest joining a running session lands on the host position', async () => {
  const env = loadJamConnect({ latencyMs: () => 30 });
  const { host } = await startSession(env, { guests: 0 });
  host.startTransport(132);
  env.clock.advance(1234);

  const { sessionId, authToken } = host;
  const guest = new env.JamConnector('Acid303', env.createTone());
  const joining = guest.joinHost(`${sessionId}:${authToken}`);
  env.clock.advance(400);
  await joining;
  assert.equal(guest.Tone.Transport.state, 'started');
  assert.equal(guest.Tone.Transport.bpm.value, 132);
  assert.ok(phaseErrorTicks(env, host, guest) < TICK_TOLERANCE, `phase error ${phaseErrorTicks(env, host, guest)} ticks`);
});

test('a start from a guest is relayed so the host and other guests line up with it', async () => {
  const env = loadJamConnect({ latencyMs: () => 30 });
  const { host, guests: [a, b] } = await startSession(env, { guests: 2 });
  a.startTransport(120);
  env.clock.advance(300);
  assert.ok(phaseErrorTicks(env, a, host) < TICK_TOLERANCE, `host vs A: ${phaseErrorTicks(env, a, host)} ticks`);
  assert.ok(phaseErrorTicks(env, a, b) < TICK_TOLERANCE, `B vs A: ${phaseErrorTicks(env, a, b)} ticks`);
});

test('pads use the measured RTT on the host, with no 20 ms guess', async () => {
  const env = loadJamConnect({ latencyMs: () => 30 });
  const { host, guests: [guest] } = await startSession(env);
  const played = [];
  host.onPadTriggered = (app, instrument, note, velocity, time) => played.push(time - host.Tone.now());

  guest.hostConn.send({ type: 'PAD_PLAY', appName: 'Acid303', instrument: 'bass', note: 'C2', velocity: 0.8, delayFromSendMs: 0 });
  guest.hostConn.send({ type: 'PAD_PLAY', appName: 'Acid303', instrument: 'bass', note: 'C2', velocity: 0.8, delayFromSendMs: 50 });
  env.clock.advance(100);
  assert.equal(played.length, 2);
  assert.ok(Math.abs(played[0]) < 1e-9, 'on-grid pad plays immediately');
  assert.ok(Math.abs(played[1] - 0.020) < 1e-9, '50 ms lead minus the 30 ms measured transit');
});

test('solo start is immediate (no +0.5 s)', async () => {
  const env = loadJamConnect();
  const client = new env.JamConnectClient('Acid303', null);
  await client.startTransport();
  const [start] = env.ctx.Tone.Transport.starts;
  assert.ok(Math.abs(start.at - env.ctx.Tone.now()) < 1e-9);
});