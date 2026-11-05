import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { StatePublisher } from '../src/publisher.js';
import { testClock } from './helpers/clock.js';

test('never more than 300 states a minute, simultaneous flushes included; the rest waits', async () => {
  const clock = testClock();
  const gladys = createFakeGladys({ selector: 'airtouch5' });
  const sent = [];
  gladys.publishChangedStates = async (batch) => {
    sent.push(...batch);
    return { success: true, count: batch.length };
  };
  const publisher = new StatePublisher({
    gladys,
    logger: { warn() {} },
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  for (let i = 0; i < 400; i += 1) publisher.push(`ext:airtouch5:f${i}`, { state: i });
  await Promise.all([publisher.flush(), publisher.flush(), publisher.flush(), publisher.flush()]);
  await publisher.flush();
  await publisher.flush();
  assert.equal(sent.length, 300);
  await clock.advance(60_001);
  await publisher.flush();
  assert.equal(sent.length, 400);
});
