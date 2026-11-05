// -----------------------------------------------------------------------------
// The protocol against the frames of the Polyaire document and of real
// consoles, as airtouch5py 0.5.1 carries them in its tests (Apache-2.0).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AC_POWER,
  ZONE_POWER,
  acAbilityRequest,
  acControl,
  acStatusRequest,
  crc16,
  parseIdentity,
  readFrame,
  setpointByte,
  setpointRange,
  splitFrames,
  versionRequest,
  zoneControl,
  zoneNameRequest,
  zoneStatusRequest,
} from '../src/airtouch/protocol.js';

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const one = (bytes) => {
  const { frames, bad, dropped } = splitFrames(bytes);
  assert.equal(frames.length, 1);
  assert.equal(bad + dropped, 0);
  return readFrame(frames[0]);
};

const DOC = {
  zoneControl: '555555aa80b00fc0000c20000000000400010102ff00f0a1',
  zoneStatusRequest: '555555aa80b001c000082100000000000000a431',
  zoneStatus: '555555aab08001c0001821000000000800024080968002e700000164ff0007ff0000b9ef',
  acControl: '555555aa80b001c0000c220000000004000121ff00ffd347',
  acControlTwo: '555555aa80b001c000102200000000040002004f00ff01ff40a0104b',
  acStatusRequest: '555555aa80b001c0000823000000000000007db0',
  acStatus: '555555aab08001c0001c23000000000a0002101278c002da00008000014264c002e4000080003d79',
  acStatus120: '555555aab08007c0001623000000000e0001101282c50abf0000e500e2e40000a7d5',
  intelligentAuto: '555555aafd807ec0001623000000000e000100385ac10aa800008000e2a80000a0ce',
  abilityRequest: '555555aa90b0011f0003ff11000983',
  ability: '555555aab090011f001cff110018554e49540000000000000000000000000004171d101f121fa226',
  namesRequest: '555555aa90b0011f0002ff1342cd',
  names:
    '555555aab090031f003cff1300064d6173746572010a43616de280997320726f020652756d707573030c447261676f6e73206c616972040644696e696e6705064c6f756e6765c919',
  versionRequest: '555555aa90b0011f0002ff309b8c',
  version: '555555aab090011f000fff30000b312e302e332c312e302e331328',
};

test('CRC16 Modbus of the frames of the document', () => {
  for (const frame of Object.values(DOC)) {
    const bytes = hex(frame);
    assert.equal(crc16(bytes.subarray(4, -2)), bytes.readUInt16BE(bytes.length - 2));
  }
});

test('requests: byte for byte the frames of the document', () => {
  assert.deepEqual(acStatusRequest(1), hex(DOC.acStatusRequest));
  assert.deepEqual(zoneStatusRequest(1), hex(DOC.zoneStatusRequest));
  assert.deepEqual(zoneNameRequest(1), hex(DOC.namesRequest));
  assert.deepEqual(versionRequest(1), hex(DOC.versionRequest));
  // The ability request of the document asks one AC (00); ours asks them all.
  assert.deepEqual(acAbilityRequest(1).subarray(0, 12), hex('555555aa90b0011f0002ff11'));
  assert.deepEqual(zoneControl(0x0f, [{ zone: 1, power: ZONE_POWER.OFF }]), hex(DOC.zoneControl));
  assert.deepEqual(acControl(1, [{ ac: 1, power: AC_POWER.OFF }]), hex(DOC.acControl));
  assert.deepEqual(
    acControl(1, [
      { ac: 0, mode: 4 },
      { ac: 1, power: 0, setpoint: 26 },
    ]),
    hex(DOC.acControlTwo),
  );
});

test('AC status of the document and of consoles 1.2.0 (14-byte entries)', () => {
  const doc = one(hex(DOC.acStatus));
  assert.equal(doc.kind, 'ac-status');
  assert.deepEqual(
    doc.value.map(({ ac, on, mode, fan, setpoint, temperature, error }) => ({
      ac,
      on,
      mode,
      fan,
      setpoint,
      temperature,
      error,
    })),
    [
      { ac: 0, on: true, mode: 'heat', fan: 'low', setpoint: 22, temperature: 23, error: 0 },
      { ac: 1, on: false, mode: 'cool', fan: 'low', setpoint: 20, temperature: 24, error: 0 },
    ],
  );
  const v120 = one(hex(DOC.acStatus120)).value[0];
  assert.deepEqual([v120.on, v120.mode, v120.setpoint, v120.temperature], [true, 'heat', 23, 20.3]);
  // "Intelligent auto" (8-14), not in the document, sent by real consoles: auto.
  assert.equal(one(hex(DOC.intelligentAuto)).value[0].fan, 'auto');
});

test('zone status of the document', () => {
  const { value } = one(hex(DOC.zoneStatus));
  assert.deepEqual(value, [
    {
      zone: 0,
      on: true,
      control: 'temperature',
      percent: 0,
      setpoint: 25,
      hasSensor: true,
      temperature: 24.3,
      lowBattery: false,
    },
    {
      zone: 1,
      on: false,
      control: 'percentage',
      percent: 100,
      setpoint: undefined,
      hasSensor: false,
      temperature: undefined,
      lowBattery: false,
    },
  ]);
});

test('abilities, zone names (UTF-8) and version', () => {
  const [ability] = one(hex(DOC.ability)).value;
  assert.equal(ability.name, 'UNIT');
  assert.deepEqual([ability.startZone, ability.zoneCount], [0, 4]);
  assert.deepEqual(ability.modes, { cool: true, fan: false, dry: true, heat: true, auto: true });
  assert.deepEqual(ability.limits, { minCool: 16, maxCool: 31, minHeat: 18, maxHeat: 31 });
  assert.deepEqual(setpointRange(ability.limits), { min: 18, max: 31 });
  assert.equal(one(hex(DOC.names)).value.get(1), 'Cam’s ro');
  assert.equal(one(hex(DOC.version)).value.version, '1.0.3,1.0.3');
  // Requests read back (an echo) are not answers.
  assert.equal(one(hex(DOC.namesRequest)), undefined);
  assert.equal(one(hex(DOC.acControl)), undefined);
});

test('frames refused: wrong CRC, too long, lengths that do not add up; garbage skipped', () => {
  const bad = hex(DOC.acStatus);
  bad[bad.length - 1] ^= 0xff;
  const split = splitFrames(bad);
  assert.equal(split.frames.length, 0);
  assert.equal(split.bad, 1);
  // Garbage before a frame is dropped, the frame read.
  const glued = Buffer.concat([hex('00 55 55 01 02'), hex(DOC.version), hex(DOC.zoneStatus)]);
  const out = splitFrames(glued);
  assert.equal(out.frames.length, 2);
  assert.equal(out.dropped, 5);
  // A length over 2 KB: never waited for.
  const huge = hex('555555aab080 01 c0 ffff');
  assert.equal(splitFrames(Buffer.concat([huge, Buffer.alloc(20)])).bad, 1);
  // A status whose counts do not match its length.
  const lie = hex(DOC.acStatusRequest);
  lie[15] = 10;
  lie[17] = 3;
  const crc = crc16(lie.subarray(4, -2));
  lie.writeUInt16BE(crc, lie.length - 2);
  assert.throws(() => readFrame(splitFrames(lie).frames[0]), /does not add up/);
});

test('setpoints: within the frame of the protocol only, to 0.1 °C', () => {
  assert.equal(setpointByte(26), 160);
  assert.equal(setpointByte(10), 0);
  assert.throws(() => setpointByte(9.9));
  assert.throws(() => setpointByte(35.1));
  assert.throws(() => setpointByte(Number.NaN));
  assert.equal(setpointRange({ minCool: 0, maxCool: 30, minHeat: 16, maxHeat: 30 }), undefined);
  assert.equal(setpointRange({ minCool: 25, maxCool: 30, minHeat: 16, maxHeat: 20 }), undefined);
  assert.equal(setpointRange(undefined), undefined);
});

test('controls: several entries in one frame; out of range refused', () => {
  const frame = acControl(1, [
    { ac: 0, power: AC_POWER.OFF },
    { ac: 1, power: AC_POWER.OFF },
  ]);
  assert.equal(frame.readUInt16BE(16), 2);
  assert.throws(() => acControl(1, [{ ac: 16, power: AC_POWER.OFF }]));
  assert.throws(() => zoneControl(1, [{ zone: 1, percent: 101 }]));
  assert.throws(() => zoneControl(1, [{ zone: 1, percent: 1.5 }]));
  assert.throws(() => acControl(1, []));
});

test('UDP identity: the five fields, AirTouch5, a plain console id', () => {
  const ok = parseIdentity(Buffer.from('192.168.1.10,AT5N202502000000,AirTouch5,4300000,Upstairs'));
  assert.deepEqual(ok, {
    ip: '192.168.1.10',
    consoleId: 'at5n202502000000',
    systemId: '4300000',
    name: 'Upstairs',
  });
  for (const text of [
    '192.168.1.10,AT5N2025,AirTouch4,1,x',
    '192.168.1.10,AT5N/../x,AirTouch5,1,x',
    '192.168.1.10,AT5N2025,AirTouch5,1',
    'x'.repeat(600),
  ]) {
    assert.equal(parseIdentity(Buffer.from(text)), undefined, text.slice(0, 40));
  }
});
