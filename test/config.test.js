import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 or host name, optional port; never broadcast, multicast or 0.0.0.0', () => {
  assert.deepEqual(parseAddress('192.168.1.40'), { host: '192.168.1.40', port: 9005 });
  assert.deepEqual(parseAddress(' AirTouch.lan:9006 '), { host: 'airtouch.lan', port: 9006 });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1.255',
    '224.0.0.1',
    '239.1.2.3',
    '192.168.1.40:0',
    '192.168.1.40:70000',
    'http://x',
    'a..b',
    'host\r\nX: y',
    '1.2.3',
    'x'.repeat(300),
  ]) {
    assert.equal(parseAddress(bad), undefined, JSON.stringify(bad));
  }
});

test('configuration: strict options, bounded interval, invalid input never shown back', () => {
  const c = normalizeConfig({ address: 'bad host!', allow_commands: 'yes', poll_interval: '5' });
  assert.equal(c.address, undefined);
  assert.equal(c.invalid, true);
  assert.equal(c.allowCommands, false);
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 600);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ __proto__: { allow_commands: true } }).allowCommands, false);
});
