// -----------------------------------------------------------------------------
// The commands other than stops: behind the option, decided on a fresh
// status, bounded by the limits read on the console, confirmed only by a
// status that shows them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, firstRead, setup, settle, until } from './helpers/app.js';
import { answer } from './helpers/app.js';

const ALLOW = { config: { allow_commands: true } };
const feature = (id) => ({ external_id: id });
const click = (ctx, id, value) =>
  ctx.app.setValue(undefined, feature(id), value).then(
    () => 'ok',
    (err) => err,
  );
/** Clicks and runs the clock until the command answers. */
async function run(ctx, id, value, step = 5) {
  const result = click(ctx, id, value);
  await until(
    ctx.clock,
    async () => (await Promise.race([result, settle(1)])) !== undefined,
    'answer',
    {
      step,
    },
  );
  return result;
}

test('commands are refused with the option off (nothing written), stops are not', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  for (const [id, value] of [
    [F('ac', 1, 'power'), 1],
    [F('ac', 0, 'mode'), 2],
    [F('ac', 0, 'target-temperature'), 24],
    [F('zone', 2, 'power'), 1],
    [F('zone', 1, 'opening'), 50],
  ]) {
    assert.match((await run(ctx, id, value)).message, /disabled/);
  }
  assert.equal(ctx.dev.controls('ac').length + ctx.dev.controls('zone').length, 0);
});

test('switching on, mode, fan and setpoint: written and confirmed by the status sent back', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  assert.equal(await run(ctx, F('ac', 1, 'power'), 1), 'ok');
  assert.equal(ctx.dev.acs[1].power, 1);
  assert.equal(await run(ctx, F('ac', 0, 'mode'), 2), 'ok');
  assert.equal(ctx.dev.acs[0].mode, 1);
  assert.equal(await run(ctx, F('ac', 0, 'fan-speed'), 5), 'ok');
  assert.equal(ctx.dev.acs[0].fan, 4);
  assert.equal(await run(ctx, F('ac', 0, 'target-temperature'), 24.5), 'ok');
  assert.equal(ctx.dev.acs[0].setpoint, 24.5);
  assert.equal(await run(ctx, F('zone', 1, 'opening'), 35), 'ok');
  assert.equal(ctx.dev.zones[1].percent, 35);
  assert.equal(await run(ctx, F('zone', 0, 'target-temperature'), 21), 'ok');
  assert.equal(ctx.dev.zones[0].setpoint, 21);
});

test('setpoints bounded by the limits read on the console (both ranges), never brought into them', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  // AC 0: cooling 16-31, heating 18-30 -> 18-30.
  assert.match((await run(ctx, F('ac', 0, 'target-temperature'), 17)).message, /18 to 30/);
  assert.match((await run(ctx, F('ac', 0, 'target-temperature'), 30.5)).message, /18 to 30/);
  assert.match((await run(ctx, F('ac', 0, 'target-temperature'), 22.3)).message, /not accepted/);
  // Zone 3 belongs to AC 1: 17-28.
  assert.match((await run(ctx, F('zone', 3, 'target-temperature'), 29)).message, /17 to 28/);
  assert.equal(ctx.dev.controls('ac').length + ctx.dev.controls('zone').length, 0);
  // Limits not usable (0): refused.
  ctx.dev.abilities[0].limits.maxHeat = 0;
  ctx.app.layoutAt = undefined;
  await ctx.clock.advance(60_000);
  await until(ctx.clock, () => !ctx.app.running, 'layout read');
  assert.match((await run(ctx, F('ac', 0, 'target-temperature'), 22)).message, /limits/);
});

test('a value the AC does not list is refused (mode, fan speed); a zone without sensor has no setpoint', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  // AC 1 lists cool, heat and auto only.
  assert.match((await run(ctx, F('ac', 1, 'mode'), 3)).message, /does not offer/);
  assert.match((await run(ctx, F('ac', 0, 'fan-speed'), 7)).message, /does not offer/);
  assert.match((await run(ctx, F('zone', 1, 'target-temperature'), 22)).message, /no sensor/);
  assert.match((await run(ctx, F('zone', 1, 'opening'), 33.5)).message, /not accepted/);
  assert.match((await run(ctx, F('ac', 0, 'temperature'), 1)).message, /read only/);
});

test('a status equal to the state before is not a confirmation: "sent, without confirmation"', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.applyControls = false;
  const err = await run(ctx, F('ac', 0, 'mode'), 2);
  assert.match(err.message, /without confirmation/);
  assert.equal(ctx.dev.controls('ac').length, 1);
  // Follow-up reads 5 s and 20 s later.
  const before = ctx.dev.count(0x23);
  await ctx.clock.advance(5_000);
  await until(ctx.clock, () => ctx.dev.count(0x23) > before, 'follow-up read');
  // While it is not seen, the same command is sent again (never "already so").
  ctx.dev.applyControls = true;
  assert.equal(await run(ctx, F('ac', 0, 'mode'), 2), 'ok');
  assert.equal(ctx.dev.controls('ac').length, 2);
});

test('the option turned off between the click and the write: nothing written', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.latencyMs = 40;
  const result = click(ctx, F('ac', 0, 'mode'), 2);
  // While the status read before the command is in flight, the option goes off.
  await until(ctx.clock, () => ctx.app.session?.busy, 'fresh read in flight', { step: 1 });
  ctx.app.configUpdated({
    address: `127.0.0.1:${ctx.dev.port}`,
    allow_commands: false,
    language: 'en',
  });
  await until(
    ctx.clock,
    async () => (await Promise.race([result, settle(1)])) !== undefined,
    'answer',
    {
      step: 5,
    },
  );
  assert.match((await result).message, /disabled/);
  assert.equal(ctx.dev.controls('ac').length, 0);
});

test('a command is refused when /data cannot be written (a stop could not be kept)', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.store.fail = true;
  assert.match((await run(ctx, F('ac', 0, 'mode'), 2)).message, /\/data/);
  assert.equal(ctx.dev.controls('ac').length, 0);
  // The stop still leaves.
  assert.equal(await run(ctx, F('ac', 0, 'power'), 0), 'ok');
});

test('a command that cannot be written by 3.5 s is refused "nothing was sent"', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.silent = true;
  const err = await run(ctx, F('zone', 1, 'opening'), 10, 50);
  assert.match(err.message, /nothing was sent|could not be read/);
  assert.equal(ctx.dev.controls('zone').length, 0);
});

test('a scene over 5 zones of a slow console: all 5 set', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.latencyMs = 15;
  const results = [0, 1, 2, 3, 4].map((n) => click(ctx, F('zone', n, 'opening'), 60 + n));
  await until(
    ctx.clock,
    async () => (await Promise.race([Promise.all(results), settle(1)])) !== undefined,
    'scene',
    { step: 2 },
  );
  assert.deepEqual(await answer(ctx, Promise.all(results)), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(
    ctx.dev.zones.map((z) => z.percent),
    [60, 61, 62, 63, 64],
  );
});

test('switching on lifts the stop guard of the target once it left', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  assert.equal(await run(ctx, F('ac', 0, 'power'), 0), 'ok');
  assert.equal(ctx.app.guards.size, 1);
  assert.equal(await run(ctx, F('ac', 0, 'power'), 1), 'ok');
  assert.equal(ctx.app.guards.size, 0);
  assert.deepEqual(ctx.store.data.guards, []);
});

test('a command sent again while a previous one is not seen: a status equal to the state before confirms nothing', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.applyControls = false;
  // Heating asked, not applied (the AC stays in cooling).
  assert.match((await run(ctx, F('ac', 0, 'mode'), 2)).message, /without confirmation/);
  // Cooling asked back: it is the state already, sent again (a command is pending).
  const err = await run(ctx, F('ac', 0, 'mode'), 1);
  assert.equal(ctx.dev.controls('ac').length, 2);
  assert.match(err.message, /without confirmation/);
});
