// -----------------------------------------------------------------------------
// The devices: frozen ids, the features, the options checked by the rules of
// the core (one bad option rejects the whole Discovery list in Gladys).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  acDefinitions,
  buildAc,
  buildZone,
  commandValue,
  fallbackId,
  parseExternalId,
} from '../src/devices.js';
import { parseAbility } from '../src/airtouch/protocol.js';
import { abilityFrame, defaultSystem } from './helpers/fakeConsole.js';
import { F, firstRead, setup } from './helpers/app.js';

const CORE = `${process.env.HOME}/code/Gladys/server/utils/normalizeSupportedOptions.js`;

/** The rules of the core (server/utils/normalizeSupportedOptions.js), as a fallback. */
function coreRule(options) {
  assert.ok(Array.isArray(options));
  const values = new Set();
  for (const option of options) {
    assert.deepEqual(
      Object.keys(option).filter((k) => !['value', 'label', 'sort_order'].includes(k)),
      [],
    );
    assert.ok(Number.isInteger(option.value), 'integer value');
    assert.equal(typeof option.label, 'string');
    assert.ok(option.label.length > 0 && option.label === option.label.trim(), option.label);
    assert.ok(option.sort_order === undefined || Number.isInteger(option.sort_order));
    assert.ok(!values.has(String(option.value)), 'unique values');
    values.add(String(option.value));
  }
}

function checkOptions(devices) {
  const require = createRequire(import.meta.url);
  const core = existsSync(CORE) ? require(CORE).normalizeSupportedOptions : undefined;
  let checked = 0;
  for (const device of devices) {
    for (const feature of device.features) {
      if (feature.supported_options === undefined) continue;
      coreRule(feature.supported_options);
      if (core) core(feature.supported_options);
      checked += 1;
    }
  }
  return checked;
}

const allAbilities = () => {
  const list = [];
  for (let modes = 0; modes < 32; modes += 1) {
    for (const fans of [0, 0x01, 0x80, 0x7f, 0xff, 0x20]) {
      list.push({
        ac: 0,
        name: 'X',
        startZone: 0,
        zoneCount: 1,
        modeBits: modes,
        fanBits: fans,
        limits: { minCool: 16, maxCool: 30, minHeat: 16, maxHeat: 30 },
      });
    }
  }
  return list;
};

test('every option published follows the rules of the core, in both languages and for every ability', () => {
  const gladys = createFakeGladys({ selector: 'airtouch5' });
  const devices = [];
  for (const raw of allAbilities()) {
    const [ability] = parseAbility(abilityFrame(1, [raw]).subarray(12, -2));
    for (const language of ['en', 'fr']) {
      devices.push(buildAc(gladys, { consoleKey: 'at5n1', ability, number: 0 }, { language }));
    }
  }
  devices.push(buildAc(gladys, { consoleKey: 'at5n1', number: 3 }, { language: 'fr' }));
  assert.ok(checkOptions(devices) > 300);
});

test('the devices the app publishes pass the rules of the core', async (t) => {
  const ctx = await setup(t);
  await firstRead(ctx);
  assert.ok(checkOptions(ctx.gladys.fake.discoveredDevices) >= 4);
});

test('external ids: frozen form, parsed back strictly', () => {
  const gladys = createFakeGladys({ selector: 'airtouch5' });
  const system = defaultSystem();
  const [ability] = parseAbility(abilityFrame(1, system.abilities).subarray(12, -2));
  const ac = buildAc(
    gladys,
    { consoleKey: 'at5n2025000001', ability, number: 0 },
    { language: 'en' },
  );
  assert.equal(ac.external_id, 'ext:airtouch5:airtouch5:at5n2025000001:ac0');
  assert.deepEqual(
    ac.features.map((f) => f.external_id.split(':').at(-1)),
    ['power', 'mode', 'fan-speed', 'target-temperature', 'temperature'],
  );
  const zone = buildZone(
    gladys,
    {
      consoleKey: 'at5n2025000001',
      number: 12,
      name: 'Office',
      hasSensor: true,
      range: { min: 18, max: 30 },
    },
    { language: 'fr' },
  );
  assert.equal(zone.external_id, 'ext:airtouch5:airtouch5:at5n2025000001:zone12');
  assert.equal(zone.name, 'Office');
  assert.deepEqual(parseExternalId(F('zone', 12, 'opening')), {
    console: 'at5n2025000001',
    kind: 'zone',
    number: 12,
    key: 'opening',
  });
  for (const bad of [
    'ext:airtouch5:airtouch5:at5n2025000001:zone64',
    'ext:airtouch5:airtouch5:at5n2025000001:ac16',
    'ext:airtouch5:airtouch5:at5n2025000001:ac01',
    'ext:airtouch5:airtouch5:at5n2025000001:ac0:speed',
    'ext:airtouch5:airtouch5:AT5N:ac0',
  ]) {
    assert.equal(parseExternalId(bad), undefined, bad);
  }
  assert.equal(fallbackId('192.168.1.60:9006'), 'a-192-168-1-60-9006');
});

test('a device published again keeps the features of the created device', () => {
  const gladys = createFakeGladys({ selector: 'airtouch5' });
  const created = buildZone(
    gladys,
    { consoleKey: 'at5n1', number: 1, hasSensor: true, range: { min: 18, max: 30 } },
    { language: 'en' },
  );
  const again = buildZone(
    gladys,
    { consoleKey: 'at5n1', number: 1, hasSensor: false, range: { min: 18, max: 30 }, ac: 0 },
    { language: 'en', created },
  );
  assert.equal(again.features.length, created.features.length);
});

test('command values: strict numbers, the setpoint to 0.5 °C, a damper 0-100', () => {
  assert.deepEqual(commandValue('ac', 'power', 0), { field: 'on', value: false });
  assert.deepEqual(commandValue('ac', 'power', '1'), { field: 'on', value: true });
  assert.equal(commandValue('ac', 'power', 2), undefined);
  assert.equal(commandValue('ac', 'power', ''), undefined);
  assert.equal(commandValue('ac', 'power', null), undefined);
  assert.deepEqual(commandValue('ac', 'mode', 2), { field: 'mode', value: 'heat' });
  assert.equal(commandValue('zone', 'mode', 2), undefined);
  assert.equal(commandValue('ac', 'fan-speed', 4), undefined);
  assert.deepEqual(commandValue('ac', 'target-temperature', 21.5), {
    field: 'setpoint',
    value: 21.5,
    asked: 21.5,
  });
  assert.equal(commandValue('ac', 'target-temperature', 21.3), undefined);
  assert.equal(commandValue('zone', 'opening', 101), undefined);
  assert.equal(commandValue('ac', 'opening', 10), undefined);
  assert.equal(commandValue('zone', 'temperature', 10), undefined);
});

test('the setpoint feature of an AC: the limits read, else the frame of the protocol', () => {
  const defs = acDefinitions(undefined, 'en');
  assert.deepEqual([defs['target-temperature'].min, defs['target-temperature'].max], [10, 35]);
});
