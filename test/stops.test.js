// -----------------------------------------------------------------------------
// The stops (an AC or a zone switched off): never refused, never skipped,
// kept until a status shows them, sent first.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONSOLE_ID, F, firstRead, setup, settle, until } from './helpers/app.js';
import { answer } from './helpers/app.js';
import { fakeConsole } from './helpers/fakeConsole.js';

const feature = (id) => ({ external_id: id });
const click = (ctx, id, value) =>
  ctx.app.setValue(undefined, feature(id), value).then(
    () => 'ok',
    (err) => err,
  );

test('a stop leaves with the commands option off, is confirmed by the status it gets back', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  assert.equal(ctx.app.config.allowCommands, false);
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'stop written');
  assert.equal(await result, 'ok');
  assert.equal(ctx.dev.acs[0].power, 0);
  const guard = [...ctx.app.guards.values()][0];
  assert.equal(guard.confirmed, true);
  assert.deepEqual(ctx.store.data.guards, [
    { id: CONSOLE_ID, target: 'ac:0', sent: true, confirmed: true, resends: 0 },
  ]);
});

test('a stop is never skipped as "already off", and a zone stop leaves too', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  // AC 1 and zone 2 are already off.
  const a = click(ctx, F('ac', 1, 'power'), 0);
  const z = click(ctx, F('zone', 2, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('zone').length === 1, 'zone stop written');
  assert.equal(ctx.dev.controls('ac').length, 1);
  // Already off before: the status still shows it off after the write.
  assert.equal(await a, 'ok');
  assert.equal(await z, 'ok');
});

test('a stop works before the configuration is read, from the address kept in /data', async (t) => {
  const ctx = await setup(t, { connect: false });
  ctx.store.data = {
    format: 1,
    address: `127.0.0.1:${ctx.dev.port}`,
    id: CONSOLE_ID,
    consoleId: CONSOLE_ID,
    attemptAt: 0,
    guards: [],
  };
  let fail = true;
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  t.mock.method(ctx.gladys, 'getConfig', async () => {
    // The SDK reads it too while connecting: only the app's reads fail.
    if (fail && new Error().stack.includes('readConfig')) throw new Error('Gladys busy');
    return real();
  });
  await ctx.gladys.connect();
  assert.equal(ctx.app.config, undefined);
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'stop written');
  assert.equal(await result, 'ok');
  // Other commands wait for the configuration.
  assert.match((await answer(ctx, click(ctx, F('ac', 0, 'mode'), 1))).message, /configuration/);
  // getConfig() is tried again, for life, until it answers.
  fail = false;
  await until(ctx.clock, () => ctx.app.config !== undefined, 'configuration read', { step: 1000 });
});

test('a stop kept in /data leaves at start, before any read and without the configuration', async (t) => {
  const ctx = await setup(t, { connect: false });
  ctx.store.data = {
    format: 1,
    address: `127.0.0.1:${ctx.dev.port}`,
    id: CONSOLE_ID,
    consoleId: CONSOLE_ID,
    attemptAt: 0,
    guards: [{ id: CONSOLE_ID, target: 'zone:1', sent: false, confirmed: false, resends: 0 }],
  };
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  t.mock.method(ctx.gladys, 'getConfig', async () => {
    if (new Error().stack.includes('readConfig')) throw new Error('Gladys busy');
    return real();
  });
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.dev.controls('zone').length === 1, 'kept stop written');
  // Written first: before any status request.
  assert.equal(ctx.dev.frames[0].sub, 0x20);
  assert.equal(ctx.dev.zones[1].power, 0);
  await until(ctx.clock, () => ctx.store.data.guards[0]?.confirmed === true, 'confirmed in /data');
  // Nothing is shown before the configuration is read (only the stop left).
  await ctx.clock.advance(2_000);
  assert.equal(ctx.app.identity, 'ok');
  assert.equal(ctx.gladys.fake.states.length, 0);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
});

test('a stop with the console unreachable is kept, then sent first when it answers', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  // The console goes away.
  await ctx.dev.close();
  ctx.app.closeSession('test');
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([result, settle(1)])) !== undefined,
    'answer',
    {
      step: 100,
    },
  );
  const err = await result;
  assert.match(err.message, /not sent.*kept/i);
  assert.deepEqual(ctx.store.data.guards, [
    { id: CONSOLE_ID, target: 'ac:0', sent: false, confirmed: false, resends: 0 },
  ]);
  assert.match(JSON.stringify(ctx.gladys.fake.connectionStatus), /not sent yet/);
  // The console answers again: the stop leaves first, before the next read.
  const back = await fakeConsole({ port: ctx.dev.port });
  t.after(() => back.close());
  await until(ctx.clock, () => back.controls('ac').length === 1, 'kept stop sent', { step: 1000 });
  assert.equal(back.frames[0].sub, 0x22);
  assert.equal(back.acs[0].power, 0);
  await until(ctx.clock, () => ctx.store.data.guards[0].confirmed === true, 'confirmed', {
    step: 100,
  });
});

test('a stop cuts a read that received nothing for a second, on a new session (one at a time)', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.dev.ignore.add('ac-status');
  // The next read hangs on the AC status.
  const reading = ctx.app.tick();
  await until(ctx.clock, () => ctx.app.session?.busy, 'read in flight', { step: 1 });
  ctx.dev.ignore.delete('ac-status');
  const t0 = ctx.clock.elapsed;
  const result = click(ctx, F('zone', 0, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('zone').length === 1, 'stop written', { step: 50 });
  const waited = ctx.clock.elapsed - t0;
  assert.ok(waited >= 1000 && waited < 1600, `cut after ${waited} ms`);
  assert.equal(await result, 'ok');
  await answer(ctx, reading);
  // The new session opened once the old socket was closed.
  assert.equal(ctx.sockets.peak, 1);
  assert.equal(ctx.dev.connections, 2);
  // Not a failure of the console.
  assert.equal(ctx.app.failures, 0);
});

test('a stop never waits for /data (a save that hangs)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  await firstRead(ctx);
  store.hang = true;
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'stop written', { step: 5 });
  assert.equal(await result, 'ok');
  // And several stops in a row still leave.
  const b = click(ctx, F('zone', 0, 'power'), 0);
  const c = click(ctx, F('zone', 1, 'power'), 0);
  await until(
    ctx.clock,
    () => ctx.dev.zones[0].power === 0 && ctx.dev.zones[1].power === 0,
    'two stops',
    {
      step: 5,
    },
  );
  assert.equal(await b, 'ok');
  assert.equal(await c, 'ok');
});

test('a stop not applied is sent again by the reads that contradict it, 3 times at most', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.dev.applyControls = false;
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([result, settle(1)])) !== undefined,
    'answer',
  );
  assert.match((await result).message, /without confirmation/);
  // Each read showing it on sends it again (counted when written), 3 times.
  for (let i = 0; i < 6; i += 1) {
    await ctx.clock.advance(60_000);
    await until(ctx.clock, () => !ctx.app.running, 'read done');
  }
  assert.equal(ctx.dev.controls('ac').length, 4);
  const guard = [...ctx.app.guards.values()][0];
  assert.equal(guard.resends, 3);
  assert.equal(guard.confirmed, false);
  assert.match(JSON.stringify(ctx.gladys.fake.connectionStatus), /3 times/);
});

test('a confirmed stop is lifted by the target read on twice (switched on elsewhere), never by the time', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  assert.equal(await answer(ctx, click(ctx, F('ac', 0, 'power'), 0)), 'ok');
  await ctx.clock.advance(24 * 3600_000);
  assert.equal(ctx.app.guards.size, 1);
  ctx.dev.acs[0].power = 1;
  ctx.dev.push('ac');
  await until(ctx.clock, () => ctx.app.acs.get(0).state.on === true, 'push read');
  assert.equal(ctx.app.guards.size, 1);
  ctx.dev.push('ac');
  await until(ctx.clock, () => ctx.app.guards.size === 0, 'lifted');
  // Never sent again: switched on by someone else.
  assert.equal(ctx.dev.controls('ac').length, 1);
});

test('a stop cancels the command of the same target still waiting', async (t) => {
  const ctx = await setup(t, { config: { allow_commands: true } });
  await firstRead(ctx);
  ctx.dev.latencyMs = 30;
  const command = click(ctx, F('ac', 0, 'mode'), 2);
  const stop = click(ctx, F('ac', 0, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([stop, settle(1)])) !== undefined,
    'stop',
    {
      step: 5,
    },
  );
  assert.equal(await stop, 'ok');
  const err = await answer(ctx, command);
  assert.notEqual(err, 'ok');
  // Nothing of the command after the stop.
  const controls = ctx.dev.controls('ac');
  const last = controls.at(-1).entries[0];
  assert.equal(last[0] >> 4, 0b0010);
});

test('a stop leaves with the queue of commands full', async (t) => {
  const ctx = await setup(t, { config: { allow_commands: true } });
  await firstRead(ctx);
  ctx.dev.latencyMs = 20;
  const waiting = [];
  for (let i = 0; i < 20; i += 1) waiting.push(click(ctx, F('zone', i % 5, 'opening'), 10 + i));
  const stop = click(ctx, F('ac', 1, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([stop, settle(1)])) !== undefined,
    'stop',
    {
      step: 5,
    },
  );
  assert.equal(await stop, 'ok');
  const results = await answer(ctx, Promise.all(waiting));
  assert.ok(results.some((r) => r !== 'ok' && /Too many/.test(r.message)));
});

test('a stop sent before a configuration change is still confirmed after it', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.dev.ignore.add('ac-control');
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([result, settle(1)])) !== undefined,
    'answer',
  );
  assert.match((await result).message, /without confirmation/);
  // The interval changes: a new session; its first status shows the AC off.
  await ctx.app.configUpdated({
    address: `127.0.0.1:${ctx.dev.port}`,
    poll_interval: 120,
    language: 'en',
  });
  await until(ctx.clock, () => [...ctx.app.guards.values()][0]?.confirmed === true, 'confirmed', {
    step: 1000,
    max: 200_000,
  });
});

test('during a stop in flight, other commands of the target are refused; a zone being stopped keeps its damper', async (t) => {
  const ctx = await setup(t, { config: { allow_commands: true } });
  await firstRead(ctx);
  ctx.dev.applyControls = false;
  ctx.dev.ignore.add('ac-control');
  const stop = click(ctx, F('ac', 0, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'stop written', { step: 5 });
  assert.match(
    (await answer(ctx, click(ctx, F('ac', 0, 'mode'), 2))).message,
    /stop of this device/,
  );
  // The console answers again (the session of the unanswered stop is closed, a new one opens).
  ctx.dev.ignore.delete('ac-control');
  await until(
    ctx.clock,
    async () => (await Promise.race([stop, settle(1)])) !== undefined,
    'answer',
  );
  // A zone stop answered by a status still showing it on: sent, not seen applied.
  const zoneStop = click(ctx, F('zone', 1, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([zoneStop, settle(1)])) !== undefined,
    'answer',
    {
      step: 5,
    },
  );
  assert.match((await answer(ctx, zoneStop)).message, /without confirmation/);
  // Its damper is not moved meanwhile.
  assert.match(
    (await answer(ctx, click(ctx, F('zone', 1, 'opening'), 40))).message,
    /stop of this zone/,
  );
  assert.equal(ctx.dev.zones[1].percent, 80);
});

test('a stop clicked after the state read of a command, before its write: the command is not written', async (t) => {
  const ctx = await setup(t, { config: { allow_commands: true } });
  await firstRead(ctx);
  ctx.dev.latencyMs = 40;
  const command = click(ctx, F('ac', 0, 'mode'), 2);
  // The command reads the state first; the stop comes during that read.
  await until(ctx.clock, () => ctx.app.session?.busy && ctx.app.lane.holder === 1, 'state read', {
    step: 1,
  });
  const stop = click(ctx, F('ac', 0, 'power'), 0);
  await until(
    ctx.clock,
    async () => (await Promise.race([stop, settle(1)])) !== undefined,
    'stop',
    {
      step: 5,
    },
  );
  assert.equal(await stop, 'ok');
  assert.match((await answer(ctx, command)).message, /Cancelled by a stop/);
  assert.deepEqual(
    ctx.dev.controls('ac').map((f) => f.entries[0][0] >> 4),
    [0b0010],
  );
});

test('a stop kept unsent is never taken as applied by a status read before it left', async (t) => {
  const ctx = await setup(t, { connect: false, console: { greet: true } });
  ctx.store.data = {
    format: 1,
    address: `127.0.0.1:${ctx.dev.port}`,
    id: CONSOLE_ID,
    consoleId: CONSOLE_ID,
    attemptAt: 0,
    // AC 1 is off already: the status the console sends at once shows it.
    guards: [{ id: CONSOLE_ID, target: 'ac:1', sent: false, confirmed: false, resends: 0 }],
  };
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'kept stop still sent');
  assert.equal(ctx.dev.controls('ac')[0].entries[0][0], 0x21);
});
