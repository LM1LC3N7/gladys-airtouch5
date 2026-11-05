// -----------------------------------------------------------------------------
// The UDP identification: unicast, the answer only from the address asked.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { identityOnce, queryIdentity } from '../src/airtouch/discovery.js';

async function udpConsole(t, answer) {
  const socket = dgram.createSocket('udp4');
  const asked = [];
  socket.on('message', (message, rinfo) => {
    asked.push(message.toString('utf8'));
    const reply = answer(message);
    if (reply) socket.send(Buffer.from(reply), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  t.after(() => socket.close());
  return { port: socket.address().port, asked };
}

test('the console answers its identity to the source of the request', async (t) => {
  const dev = await udpConsole(t, () => '127.0.0.1,AT5N202502000001,AirTouch5,4300000,Home');
  const identity = await identityOnce({ ip: '127.0.0.1', port: dev.port, waitMs: 1000 });
  assert.equal(identity.consoleId, 'at5n202502000001');
  assert.deepEqual(dev.asked, ['::REQUEST-POLYAIRE-AIRTOUCH-DEVICE-INFO:;']);
});

test('an answer naming another address, or no answer: undefined after the tries', async (t) => {
  const dev = await udpConsole(t, () => '10.0.0.9,AT5N202502000001,AirTouch5,4300000,Home');
  assert.equal(
    await queryIdentity({ ip: '127.0.0.1', port: dev.port, tries: 2, waitMs: 100 }),
    undefined,
  );
  assert.equal(dev.asked.length, 2);
  const mute = await udpConsole(t, () => undefined);
  assert.equal(await identityOnce({ ip: '127.0.0.1', port: mute.port, waitMs: 50 }), undefined);
});
