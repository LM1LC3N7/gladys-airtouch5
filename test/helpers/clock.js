// -----------------------------------------------------------------------------
// A virtual clock for an app that takes `now`, `monotonic` and `timers` by
// injection (the one of gladys-testkit, copied: the tests import nothing
// outside the repository). Nothing fires by itself; every read of the clock
// moves it by 1 µs (a decision reading it twice sees it move); `advance(ms)`
// fires the timers due on the way, in order, without awaiting their promise,
// with a turn of the event loop between two.
// -----------------------------------------------------------------------------

/** Lets pending promises and I/O callbacks run (a few turns of the event loop). */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const handle = (id) => ({
  id,
  ref() {
    return this;
  },
  unref() {
    return this;
  },
  hasRef: () => true,
});

export function testClock({ start = Date.UTC(2026, 0, 1), step = 0.001 } = {}) {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const read = () => (t += step);
  const add = (fn, ms, args, every) => {
    const h = handle((seq += 1));
    const delay = Math.max(0, Number(ms) || 0);
    pending.set(h, { fn, args, at: t + delay, seq, every: every ? Math.max(1, delay) : 0 });
    return h;
  };
  const remove = (h) => pending.delete(h);
  return {
    now: () => start + read(),
    monotonic: () => read(),
    get elapsed() {
      return t;
    },
    get pending() {
      return pending.size;
    },
    timers: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => add(fn, ms, args, true),
      clearTimeout: remove,
      clearInterval: remove,
    },
    async advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        let next;
        for (const [h, timer] of pending) {
          if (
            timer.at <= target &&
            (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq))
          ) {
            next = [h, timer];
          }
        }
        if (!next) break;
        const [h, timer] = next;
        t = Math.max(t, timer.at);
        if (timer.every) timer.at += timer.every;
        else pending.delete(h);
        timer.fn(...timer.args);
        await settle(1);
      }
      t = Math.max(t, target);
      await settle(1);
    },
  };
}

/** Waits (real time, bounded) for `condition()`; throws with `what` past `ms`. */
export async function waitFor(condition, what = 'condition', ms = 3000) {
  const deadline = performance.now() + ms;
  for (;;) {
    if (await condition()) return;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
