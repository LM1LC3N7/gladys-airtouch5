// -----------------------------------------------------------------------------
// The points of review r1: each correction has its test (a mutant that
// breaks it fails here, never hangs: every wait is bounded).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tcpConnect } from '../src/airtouch/session.js';
import { CONSOLE_ID, F, answer, firstRead, setup, settle, until } from './helpers/app.js';
import { fakeConsole } from './helpers/fakeConsole.js';

const ALLOW = { config: { allow_commands: true } };
const click = (ctx, id, value) =>
  ctx.app.setValue(undefined, { external_id: id }, value).then(
    () => 'ok',
    (err) => err,
  );
test('r1-1: the answer to a stop never sends it again; one resend per read written after it', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  // The console answers the state before and never applies it.
  ctx.dev.applyControls = false;
  const result = click(ctx, F('ac', 0, 'power'), 0);
  assert.match((await answer(ctx, result)).message, /without confirmation/);
  assert.equal(ctx.dev.controls('ac').length, 1);
  // The follow-up reads (5 s, 20 s after the answer) and the periodic read send it again.
  await ctx.clock.advance(5_000);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 2, 'resend at 5 s', { step: 100 });
  await ctx.clock.advance(15_000);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 3, 'resend at 20 s', {
    step: 100,
  });
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 4, 'resend at the read', {
    step: 1000,
    max: 120_000,
  });
  await ctx.clock.advance(120_000);
  await settle(5);
  assert.equal(ctx.dev.controls('ac').length, 4);
  assert.equal([...ctx.app.guards.values()][0].resends, 3);
});

test('r1-1: a console that answers the state before and applies later (pushed): confirmed, never resent', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  ctx.dev.applyControls = false;
  ctx.dev.timers = ctx.clock.timers;
  const result = click(ctx, F('ac', 0, 'power'), 0);
  await until(ctx.clock, () => ctx.dev.controls('ac').length === 1, 'stop written', { step: 5 });
  ctx.clock.timers.setTimeout(() => {
    ctx.dev.acs[0].power = 0;
    ctx.dev.push('ac');
  }, 500);
  assert.equal(await answer(ctx, result), 'ok');
  const guard = [...ctx.app.guards.values()][0];
  assert.equal(guard.confirmed, true);
  assert.equal(guard.resends, 0);
  assert.equal(ctx.dev.controls('ac').length, 1);
});

test('r1-2: switching on a target under a stop guard is written even when it reads on, and lifts it', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.applyControls = false;
  assert.match((await answer(ctx, click(ctx, F('zone', 1, 'power'), 0))).message, /without/);
  assert.match(
    (await answer(ctx, click(ctx, F('zone', 1, 'opening'), 40))).message,
    /stop of this zone/,
  );
  // It reads on already: the status showing it on answers the click.
  assert.equal(await answer(ctx, click(ctx, F('zone', 1, 'power'), 1)), 'ok');
  // The last control written for the zone switches it on (power bits 011).
  const last = ctx.dev.controls('zone').at(-1).entries[0];
  assert.deepEqual([last[0], last[1] & 0x07], [1, 0b011]);
  assert.equal(ctx.app.guards.size, 0);
  await until(ctx.clock, () => ctx.store.data.guards.length === 0, 'lifted in /data');
  ctx.dev.applyControls = true;
  assert.equal(await answer(ctx, click(ctx, F('zone', 1, 'opening'), 40)), 'ok');
});

for (const delay of [300, 700]) {
  test(`r1-3: the configuration never cuts the session of a kept stop (connection in ${delay} ms)`, async (t) => {
    const holder = {};
    const ctx = await setup(t, {
      connect: false,
      app: {
        connect: async (args) => {
          await new Promise((resolve) => holder.clock.timers.setTimeout(resolve, delay));
          return tcpConnect(args);
        },
      },
    });
    holder.clock = ctx.clock;
    ctx.store.data = {
      format: 1,
      address: `127.0.0.1:${ctx.dev.port}`,
      id: CONSOLE_ID,
      consoleId: CONSOLE_ID,
      attemptAt: 0,
      guards: [{ id: CONSOLE_ID, target: 'zone:1', sent: false, confirmed: false, resends: 0 }],
    };
    const t0 = ctx.clock.elapsed;
    const connecting = ctx.gladys.connect();
    await until(ctx.clock, () => ctx.dev.controls('zone').length === 1, 'kept stop written', {
      step: 10,
    });
    const at = ctx.clock.elapsed - t0;
    assert.ok(at < delay + 300, `written at ${at} ms`);
    assert.equal(ctx.dev.connections, 1);
    await answer(ctx, connecting);
  });
}

for (const latency of [500, 900]) {
  test(`r1-4: a scene over 5 zones of a console answering in ${latency} ms: all 5 set`, async (t) => {
    const ctx = await setup(t, ALLOW);
    await firstRead(ctx);
    ctx.dev.timers = ctx.clock.timers;
    ctx.dev.latencyMs = latency;
    const results = [0, 1, 2, 3, 4].map((n) => click(ctx, F('zone', n, 'opening'), 60 + n));
    assert.deepEqual(await answer(ctx, Promise.all(results), { step: 10 }), [
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    assert.deepEqual(
      ctx.dev.zones.map((z) => z.percent),
      [60, 61, 62, 63, 64],
    );
    // One status read and one write for the five.
    assert.equal(ctx.dev.controls('zone').length, 1);
  });
}

test('r1-5: the UDP port 49005 taken: said in the status', async (t) => {
  const ctx = await setup(t, {
    app: {
      identify: async ({ onEphemeral, port, localPort }) => {
        assert.deepEqual([port, localPort], [49005, 49005]);
        onEphemeral(true);
        return { consoleId: CONSOLE_ID };
      },
    },
  });
  await firstRead(ctx);
  await ctx.app.publishAll();
  assert.match(JSON.stringify(ctx.gladys.fake.connectionStatus), /49005 is taken/);
});

test('r1-6: stops go before the commands and the reads waiting (lane priorities)', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.timers = ctx.clock.timers;
  ctx.dev.latencyMs = 600;
  // A read holds the lane (its next request waits behind it); commands queue.
  const reading = ctx.app.tick();
  await until(ctx.clock, () => ctx.app.session?.busy, 'read in flight', { step: 5 });
  const commands = [0, 1, 2].map((n) => click(ctx, F('zone', n, 'opening'), 10 + n));
  await ctx.clock.advance(50);
  const seen = ctx.dev.frames.length;
  const stop = click(ctx, F('zone', 4, 'power'), 0);
  await answer(ctx, Promise.all([...commands, stop, reading]), { step: 10 });
  // The first frame written after the request in flight is the stop.
  const next = ctx.dev.frames[seen];
  assert.equal(next.sub, 0x20);
  assert.equal(next.entries[0][1] & 0x07, 0b010);
});

test('r1-6: the identity is checked again right before the write', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.timers = ctx.clock.timers;
  ctx.dev.latencyMs = 100;
  const result = click(ctx, F('ac', 0, 'mode'), 2);
  await until(ctx.clock, () => ctx.app.session?.busy, 'state read in flight', { step: 5 });
  ctx.app.identity = 'other';
  assert.match((await answer(ctx, result)).message, /identity/);
  assert.equal(ctx.dev.controls('ac').length, 0);
});

test('r1-6: a stop of another console: never sent to this one, its click refused', async (t) => {
  const OTHER = 'at5n2099999999';
  const ctx = await setup(t, {
    data: {
      format: 1,
      id: CONSOLE_ID,
      consoleId: CONSOLE_ID,
      attemptAt: 0,
      guards: [{ id: OTHER, target: 'ac:0', sent: false, confirmed: false, resends: 0 }],
    },
  });
  await firstRead(ctx);
  await ctx.clock.advance(30_000);
  assert.equal(ctx.dev.controls('ac').length, 0);
  const err = await answer(ctx, click(ctx, F('ac', 0, 'power', OTHER), 0));
  assert.match(err.message, /not one of the console/);
  assert.equal(ctx.dev.controls('ac').length, 0);
});

for (const [resends, sent] of [
  [1, 1],
  [3, 0],
]) {
  test(`r1-6: at start, a stop sent and not confirmed (resends ${resends}) is sent again: ${sent}`, async (t) => {
    const ctx = await setup(t, { connect: false });
    ctx.store.data = {
      format: 1,
      address: `127.0.0.1:${ctx.dev.port}`,
      id: CONSOLE_ID,
      consoleId: CONSOLE_ID,
      attemptAt: 0,
      guards: [{ id: CONSOLE_ID, target: 'ac:1', sent: true, confirmed: false, resends }],
    };
    await ctx.gladys.connect();
    await firstRead(ctx);
    if (sent) await until(ctx.clock, () => ctx.dev.controls('ac').length === sent, 'resent');
    await ctx.clock.advance(1_000);
    assert.equal(ctx.dev.controls('ac').length, sent);
  });
}

test('r1-6: an address changed while connecting: never a session to the old one', async (t) => {
  const holder = {};
  const ctx = await setup(t, {
    connect: false,
    app: {
      connect: async (args) => {
        await new Promise((resolve) => holder.clock.timers.setTimeout(resolve, 300));
        return tcpConnect(args);
      },
    },
  });
  holder.clock = ctx.clock;
  const second = await fakeConsole();
  t.after(() => second.close());
  await answer(ctx, ctx.gladys.connect());
  // The first session is being opened (its connection takes 300 ms).
  await until(ctx.clock, () => ctx.app.opening !== undefined, 'connecting', { step: 5 });
  await ctx.app.configUpdated({ address: `127.0.0.1:${second.port}`, language: 'en' });
  await until(ctx.clock, () => second.frames.length > 0, 'read of the new console', {
    step: 50,
    max: 120_000,
  });
  await ctx.clock.advance(2_000);
  assert.equal(ctx.dev.frames.length, 0);
  // The socket opened to the old address was closed at once, never kept.
  await until(ctx.clock, () => ctx.dev.open === 0, 'old socket closed', { step: 50 });
});

test('r1-6: a mode is refused while the abilities of the AC are not read', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.app.abilities.delete(0);
  assert.match((await answer(ctx, click(ctx, F('ac', 0, 'mode'), 1))).message, /does not offer/);
  assert.equal(ctx.dev.controls('ac').length, 0);
});

test('r1-6: the option is checked on arrival: no read, no /data write', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  const reads = ctx.dev.count(0x23);
  const saves = ctx.store.saves;
  assert.match((await answer(ctx, click(ctx, F('ac', 0, 'mode'), 1))).message, /disabled/);
  await ctx.clock.advance(100);
  assert.equal(ctx.dev.count(0x23), reads);
  assert.equal(ctx.store.saves, saves);
});

test('r1 minor / r2: a read silent for the request timeout closes the session; a slow answer does not', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.ignore.add('ac-status');
  const err = await answer(ctx, click(ctx, F('ac', 0, 'mode'), 2), { step: 50 });
  assert.notEqual(err, 'ok');
  assert.equal(ctx.dev.controls('ac').length, 0);
  // Closed on the real silence (3 s after the write), not on the deadline of the command.
  await until(ctx.clock, () => ctx.app.session === undefined, 'closed on silence', { step: 50 });
});

test('r2: a command whose deadline passes while the console answers slowly keeps the session; the late answer is taken by no one', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.timers = ctx.clock.timers;
  ctx.dev.latencyMs = 2_900;
  const session = ctx.app.session;
  const err = await answer(ctx, click(ctx, F('ac', 0, 'mode'), 2), { step: 20 });
  assert.notEqual(err, 'ok');
  // The answer comes at 2.9 s from the write: swallowed, the session lives on.
  await ctx.clock.advance(3_500);
  await settle(5);
  assert.equal(ctx.app.session, session);
  assert.equal(session.closed, false);
  // The next request gets its own answer.
  ctx.dev.latencyMs = 0;
  assert.equal(await answer(ctx, click(ctx, F('zone', 1, 'opening'), 33)), 'ok');
});

for (const latency of [600, 900]) {
  test(`r2: mode + setpoint of one AC and 3 zones at once, console answering in ${latency} ms: all set`, async (t) => {
    const ctx = await setup(t, ALLOW);
    await firstRead(ctx);
    ctx.dev.timers = ctx.clock.timers;
    ctx.dev.latencyMs = latency;
    const results = [
      click(ctx, F('ac', 0, 'mode'), 2),
      click(ctx, F('ac', 0, 'target-temperature'), 24),
      ...[0, 3, 4].map((n) => click(ctx, F('zone', n, 'opening'), 50 + n)),
    ];
    const acks = await answer(ctx, Promise.all(results), { step: 10 });
    if (latency <= 600) {
      assert.deepEqual(acks, ['ok', 'ok', 'ok', 'ok', 'ok']);
    } else {
      // Two reads and two writes in a row take 3.6 s: the kind written second is
      // set but answered after the 3.5 s of the ack ("sent, without
      // confirmation"), never refused unsent.
      for (const ack of acks) assert.ok(ack === 'ok' || /without confirmation/.test(ack.message));
    }
    assert.deepEqual([ctx.dev.acs[0].mode, ctx.dev.acs[0].setpoint], [1, 24]);
    assert.deepEqual(
      [0, 3, 4].map((n) => ctx.dev.zones[n].percent),
      [50, 53, 54],
    );
    // The two settings of the AC in one entry of one frame.
    const acFrames = ctx.dev.controls('ac');
    assert.equal(acFrames.length, 1);
    assert.equal(acFrames[0].entries.length, 1);
    assert.equal(ctx.dev.controls('zone').length, 1);
  });
}

test('r2: commands clicked within the gathering time share one status read', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.timers = ctx.clock.timers;
  ctx.dev.latencyMs = 300;
  const reads = ctx.dev.count(0x21);
  const a = click(ctx, F('zone', 1, 'opening'), 41);
  // 10 ms later (the clock run in small steps, its timers firing on the way).
  for (let i = 0; i < 5; i += 1) await ctx.clock.advance(2);
  const b = click(ctx, F('zone', 4, 'opening'), 44);
  assert.deepEqual(await answer(ctx, Promise.all([a, b]), { step: 10 }), ['ok', 'ok']);
  assert.equal(ctx.dev.count(0x21) - reads, 1);
});

test('r2: a command clicked after the shared read was written never decides on it', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.timers = ctx.clock.timers;
  ctx.dev.latencyMs = 300;
  const reads = ctx.dev.count(0x21);
  const a = click(ctx, F('zone', 1, 'opening'), 41);
  await until(ctx.clock, () => ctx.dev.count(0x21) > reads, 'first read written', { step: 5 });
  const b = click(ctx, F('zone', 4, 'opening'), 44);
  assert.deepEqual(await answer(ctx, Promise.all([a, b]), { step: 10 }), ['ok', 'ok']);
  // Its own read, written after its click.
  assert.equal(ctx.dev.count(0x21) - reads, 2);
});

test('r2: a stop cut by a new address leaves at once to the new console', async (t) => {
  const holder = {};
  const ctx = await setup(t, {
    app: {
      connect: async (args) => {
        if (holder.delay)
          await new Promise((resolve) => holder.clock.timers.setTimeout(resolve, holder.delay));
        return tcpConnect(args);
      },
    },
  });
  holder.clock = ctx.clock;
  await firstRead(ctx);
  const second = await fakeConsole();
  t.after(() => second.close());
  ctx.app.closeSession('test');
  holder.delay = 300;
  const t0 = ctx.clock.elapsed;
  const stop = click(ctx, F('ac', 0, 'power'), 0);
  await ctx.clock.advance(100);
  // The address changes while the stop connects to the old one.
  await ctx.app.configUpdated({ address: `127.0.0.1:${second.port}`, language: 'en' });
  await until(ctx.clock, () => second.controls('ac').length === 1, 'stop at the new console', {
    step: 10,
  });
  assert.ok(ctx.clock.elapsed - t0 < 1_000, `${ctx.clock.elapsed - t0} ms`);
  await answer(ctx, stop);
});

test('r2: the UDP try of a closed session is stopped (it would hold port 49005)', async (t) => {
  const signals = [];
  const ctx = await setup(t, {
    app: {
      identify: ({ signal }) => {
        signals.push(signal);
        // The first try never ends by itself.
        return signals.length === 1
          ? new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined)))
          : Promise.resolve({ consoleId: CONSOLE_ID });
      },
    },
  });
  await until(ctx.clock, () => signals.length === 1 && ctx.app.session, 'first try', { step: 10 });
  ctx.app.closeSession('test');
  assert.equal(signals[0].aborted, true);
  await until(ctx.clock, () => ctx.app.live(), 'next session verified', {
    step: 1000,
    max: 120_000,
  });
});

test('r2: an opening and a setpoint of one zone at once: two frames (one value per entry), both set', async (t) => {
  const ctx = await setup(t, ALLOW);
  await firstRead(ctx);
  ctx.dev.timers = ctx.clock.timers;
  ctx.dev.latencyMs = 200;
  const acks = await answer(
    ctx,
    Promise.all([
      click(ctx, F('zone', 0, 'opening'), 70),
      click(ctx, F('zone', 0, 'target-temperature'), 24),
    ]),
    { step: 10 },
  );
  assert.deepEqual(acks, ['ok', 'ok']);
  assert.deepEqual([ctx.dev.zones[0].percent, ctx.dev.zones[0].setpoint], [70, 24]);
  assert.deepEqual(
    ctx.dev.controls('zone').map((f) => f.entries.length),
    [1, 1],
  );
});
