// -----------------------------------------------------------------------------
// Reads, pace, configuration, identity, publication.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import {
  CONSOLE_ID,
  F,
  createdDevices,
  firstRead,
  idle,
  setup,
  settle,
  until,
} from './helpers/app.js';
import { answer } from './helpers/app.js';

const statusText = (ctx) => JSON.stringify(ctx.gladys.fake.connectionStatus);

test('first read: devices, states and status', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  const { gladys } = ctx;
  const devices = gladys.fake.discoveredDevices;
  assert.equal(devices.length, 7);
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Downstairs', 'Upstairs', 'Living', 'Kitchen', 'Bedroom', 'Office', 'Guest'],
  );
  await until(ctx.clock, () => gladys.fake.lastState(F('ac', 0, 'power')) === 1, 'states');
  assert.equal(gladys.fake.lastState(F('zone', 0, 'temperature')), 23.1);
  assert.equal(gladys.fake.lastState(F('zone', 1, 'opening')), 80);
  assert.equal(gladys.fake.lastState(F('ac', 1, 'mode')), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // A zone without a sensor has no setpoint nor temperature.
  const kitchen = devices.find((d) => d.name === 'Kitchen');
  assert.deepEqual(
    kitchen.features.map((f) => f.external_id.split(':').at(-1)),
    ['power', 'opening'],
  );
  // The setpoint bounds of an AC: the limits read on the console.
  const down = devices.find((d) => d.name === 'Downstairs');
  const setpoint = down.features.find((f) => f.external_id.endsWith(':target-temperature'));
  assert.deepEqual([setpoint.min, setpoint.max], [18, 30]);
});

test('reads every interval, never sooner: restart, configuration saved, Discovery, test button', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  const reads = () => ctx.dev.count(0x23);
  assert.equal(reads(), 1);
  await ctx.app.configUpdated({ address: `127.0.0.1:${ctx.dev.port}`, language: 'en' });
  await ctx.app.scan();
  await ctx.app.connected();
  const answer = await ctx.app.testConnection();
  assert.match(answer.en, /Next read in/);
  await ctx.clock.advance(59_000);
  await settle(5);
  assert.equal(reads(), 1);
  await until(ctx.clock, () => reads() === 2, 'second read', { step: 100 });
  // A container restart: /data holds the attempt; the next read waits for the rest.
  await ctx.app.stop();
  const data = structuredClone(ctx.store.data);
  assert.ok(data.attemptAt > 0);
  const restartAt = ctx.clock.elapsed;
  const next = await setup(t, { dev: ctx.dev, data, clock: ctx.clock });
  await settle(10);
  assert.equal(reads(), 2);
  await until(next.clock, () => reads() === 3, 'read after restart', { step: 1000, max: 120_000 });
  // Saved at the first read (at most once a minute): at least a minute after it.
  assert.ok(ctx.clock.elapsed - restartAt >= 59_000, `${ctx.clock.elapsed - restartAt}`);
});

test('getConfig() failing in `connected` is tried again for life, with an exact status', async (t) => {
  const ctx = await setup(t, { connect: false });
  let failures = 3;
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  t.mock.method(ctx.gladys, 'getConfig', async () => {
    if (new Error().stack.includes('readConfig') && failures > 0) {
      failures -= 1;
      throw new Error('Gladys busy');
    }
    return real();
  });
  await ctx.gladys.connect();
  assert.equal(ctx.app.config, undefined);
  assert.match(statusText(ctx), /could not be read; next try in 5 s/);
  await ctx.clock.advance(5_000);
  assert.match(statusText(ctx), /next try in 15 s/);
  await ctx.clock.advance(15_000);
  await ctx.clock.advance(60_000);
  await until(ctx.clock, () => ctx.app.live(), 'started after the configuration', { step: 100 });
  // A reconnection to Gladys that fails to read it again: retried too.
  failures = 1;
  await ctx.app.connected();
  await ctx.clock.advance(5_000);
  await settle(5);
  assert.equal(failures, 0);
  assert.equal(ctx.app.configFailures, 0);
});

test('a reconnection to Gladys never republishes old states as new', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  await until(ctx.clock, () => ctx.gladys.fake.states.length > 0, 'states');
  const count = ctx.gladys.fake.states.length;
  await ctx.clock.advance(30_000);
  await ctx.app.connected();
  await ctx.clock.advance(2_000);
  assert.equal(ctx.gladys.fake.states.length, count);
  // A device created: only the states read within 2 minutes are sent again.
  ctx.app.acs.get(0).at = ctx.clock.monotonic() - 3 * 60_000;
  ctx.gladys.forgetPublishedStates();
  const before = ctx.gladys.fake.states.length;
  await ctx.app.deviceCreated(createdDevices()[0]);
  await ctx.clock.advance(2_000);
  const sent = ctx.gladys.fake.states.slice(before).map((s) => s.device_feature_external_id);
  assert.ok(sent.includes(F('ac', 1, 'power')));
  assert.ok(!sent.includes(F('ac', 0, 'power')));
  assert.ok(ctx.gladys.fake.states.every((s) => s.created_at === undefined));
});

test('a status pushed by the console is shown at once', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.dev.zones[1].percent = 15;
  ctx.dev.push('zone');
  await until(ctx.clock, () => ctx.gladys.fake.lastState(F('zone', 1, 'opening')) === 15, 'pushed');
});

test('identity: another console at the address: nothing shown, commands refused, stops sent', async (t) => {
  const data = { format: 1, id: CONSOLE_ID, consoleId: CONSOLE_ID, attemptAt: 0, guards: [] };
  const ctx = await setup(t, {
    data,
    identity: 'at5n2099999999',
    config: { allow_commands: true },
  });
  await until(ctx.clock, () => ctx.app.identity === 'other', 'identity checked');
  await idle(ctx);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.match(statusText(ctx), /Another AirTouch 5 console/);
  const err = await answer(
    ctx,
    ctx.app.setValue(undefined, { external_id: F('ac', 0, 'mode') }, 2).catch((e) => e),
  );
  assert.match(err.message, /Another console/);
  const stop = ctx.app.setValue(undefined, { external_id: F('ac', 0, 'power') }, 0);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'stop sent');
  await answer(ctx, stop);
  assert.equal(ctx.gladys.fake.states.length, 0);
});

test('identity: the console id kept and no UDP answer: unverified, nothing shown, never a downgrade', async (t) => {
  const data = { format: 1, id: CONSOLE_ID, consoleId: CONSOLE_ID, attemptAt: 0, guards: [] };
  const ctx = await setup(t, { data, identity: undefined });
  await until(ctx.clock, () => ctx.app.identity === 'unverified', 'identity checked');
  await idle(ctx);
  assert.equal(ctx.gladys.fake.states.length, 0);
  assert.match(statusText(ctx), /did not give its identity/);
  assert.equal(ctx.store.data.id, CONSOLE_ID);
  // It answers at a later read: shown.
  ctx.identity.consoleId = CONSOLE_ID;
  await until(ctx.clock, () => ctx.app.live(), 'verified', { step: 1000, max: 120_000 });
  await until(ctx.clock, () => ctx.gladys.fake.states.length > 0, 'states');
});

test('identity: no UDP answer the first time: the readable fallback, kept for good', async (t) => {
  const devices = createdDevices('a-127-0-0-1-9005');
  const ctx = await setup(t, { identity: undefined, devices, noAddress: true, connect: false });
  ctx.gladys.fake.config = { address: `127.0.0.1:${ctx.dev.port}`, language: 'en' };
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.app.live(), 'live');
  const key = `a-127-0-0-1-${ctx.dev.port}`;
  assert.equal(ctx.store.data.id, key);
  assert.equal(ctx.store.data.fallback, true);
  // The console id seen later only checks the identity: the ids stay.
  ctx.identity.consoleId = CONSOLE_ID;
  ctx.app.closeSession('test');
  await ctx.clock.advance(60_000);
  await until(ctx.clock, () => ctx.app.live(), 'live again', { step: 100 });
  assert.equal(ctx.store.data.id, key);
  assert.equal(ctx.store.data.consoleId, CONSOLE_ID);
});

test('/data unreadable: no new identity, nothing written over it', async (t) => {
  const store = memoryStore({
    format: 1,
    id: 'at5n2025000077',
    consoleId: 'at5n2025000077',
    attemptAt: 1,
  });
  store.unreadable = true;
  const ctx = await setup(t, { store, devices: [] });
  await until(ctx.clock, () => ctx.app.identity === 'unverified', 'identity checked');
  assert.equal(ctx.store.data.id, 'at5n2025000077');
  assert.equal(ctx.store.saves, 0);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.match(statusText(ctx), /cannot be read/);
  // Readable again: its identity is the one kept, checked against the console.
  store.unreadable = false;
  await until(ctx.clock, () => ctx.app.identity === 'other', 'read back', { step: 1000 });
});

test('/data that never answers: start bounded, read anyway', async (t) => {
  const store = memoryStore();
  store.hang = true;
  const ctx = await setup(t, { store, connect: false });
  const connecting = ctx.gladys.connect();
  await until(
    ctx.clock,
    async () => (await Promise.race([connecting.then(() => true), settle(1)])) === true,
    'connect',
  );
  assert.equal(ctx.app.memoryState, 'unreadable');
});

test('a failed session waits 30 s, 1, 2, 5 min, never less than the interval', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.dev.silent = true;
  const starts = [];
  // Each read writes one request, unanswered (the session is then closed).
  let seen = ctx.dev.frames.length;
  for (let i = 0; i < 5; i += 1) {
    await until(ctx.clock, () => ctx.dev.frames.length > seen, 'next read', {
      step: 500,
      max: 400_000,
    });
    seen = ctx.dev.frames.length;
    starts.push(ctx.clock.elapsed);
  }
  const gaps = starts.slice(1).map((v, i) => Math.round((v - starts[i]) / 1000));
  // After failures 1, 2, 3, 4: 60 s (the interval), 60 s, 2 min, 5 min (from the attempt).
  assert.deepEqual(
    gaps.map(
      (g) => [60, 61, 62].includes(g) || [120, 121, 122].includes(g) || [300, 301, 302].includes(g),
    ),
    [true, true, true, true],
    `${gaps}`,
  );
  assert.ok(gaps[2] >= 120 && gaps[3] >= 300, `${gaps}`);
  assert.match(statusText(ctx), /unreachable/);
});

test('the test button reads only when the read is due, and answers', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  const early = await ctx.app.testConnection();
  assert.match(early.en, /Next read in/);
  const again = await ctx.app.testConnection();
  assert.match(again.en, /a few seconds ago/);
});

test('a new session shows nothing read on the previous one (it may be another console)', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.app.closeSession('test');
  ctx.dev.zones[1].percent = 5;
  ctx.dev.ignore.add('zone-status');
  ctx.dev.ignore.add('ac-status');
  await ctx.clock.advance(60_000);
  await until(ctx.clock, () => ctx.app.session && ctx.app.acs.size === 0, 'new session', {
    step: 100,
  });
  assert.equal(ctx.app.zones.size, 0);
  // No partial Discovery list either.
  assert.deepEqual(ctx.app.buildDevices(), []);
});

test('a command whose /data save hangs answers within 5 s, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { allow_commands: true } });
  await firstRead(ctx);
  ctx.store.hang = true;
  const t0 = ctx.clock.elapsed;
  const result = ctx.app
    .setValue(undefined, { external_id: F('ac', 0, 'mode') }, 2)
    .catch((e) => e);
  await until(
    ctx.clock,
    async () => (await Promise.race([result, settle(1)])) !== undefined,
    'answer',
    {
      step: 50,
    },
  );
  assert.ok(ctx.clock.elapsed - t0 < 5_000);
  assert.match((await result).message, /\/data/);
  assert.equal(ctx.dev.controls('ac').length, 0);
});

test('/data lost, devices created under the fallback: the fallback is kept even when the console gives its id', async (t) => {
  const ctx = await setup(t, { devices: [], connect: false });
  const key = `a-127-0-0-1-${ctx.dev.port}`;
  ctx.gladys.fake.devices = createdDevices(key);
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.app.live(), 'live');
  assert.equal(ctx.store.data.id, key);
  assert.equal(ctx.store.data.consoleId, CONSOLE_ID);
});

test('the id of the devices is chosen only once kept in /data', async (t) => {
  const store = memoryStore();
  store.fail = true;
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.app.identity === 'unsaved', 'identity not kept');
  assert.equal(ctx.app.memory.id, undefined);
  await idle(ctx);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.match(statusText(ctx), /cannot be kept in \/data/);
  store.fail = false;
  await until(ctx.clock, () => ctx.app.live(), 'kept at a later read', {
    step: 1000,
    max: 120_000,
  });
  assert.equal(ctx.store.data.id, CONSOLE_ID);
});

test('while the identity of a new session is being checked, nothing read on it is published', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  await until(ctx.clock, () => ctx.gladys.fake.states.length > 0, 'states');
  // The next session: another console answers, its identity answer is slow.
  let release;
  ctx.app.identify = () =>
    new Promise((resolve) => {
      release = () => resolve({ consoleId: 'at5n2099999999' });
    });
  ctx.app.closeSession('test');
  ctx.dev.acs[0].setpoint = 27;
  const count = ctx.gladys.fake.states.length;
  await ctx.clock.advance(60_000);
  await until(ctx.clock, () => ctx.app.acs.size > 0, 'read on the new session', { step: 100 });
  await ctx.clock.advance(2_000);
  assert.equal(ctx.app.identity, 'pending');
  assert.equal(ctx.gladys.fake.states.length, count);
  release();
  await until(ctx.clock, () => ctx.app.identity === 'other', 'checked');
  await ctx.clock.advance(2_000);
  assert.equal(ctx.gladys.fake.states.length, count);
});

test('zone names and console version are secondary: unanswered, the read goes on', async (t) => {
  const ctx = await setup(t, { console: { ignore: new Set(['names', 'version']) } });
  await firstRead(ctx);
  assert.equal(ctx.app.online, true);
  const names = ctx.gladys.fake.discoveredDevices.map((d) => d.name);
  assert.ok(names.includes('Zone 1'));
  assert.ok(names.includes('Downstairs'));
});
