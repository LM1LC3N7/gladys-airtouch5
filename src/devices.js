// -----------------------------------------------------------------------------
// The Gladys devices of an AirTouch 5 console, their states, and the change a
// Gladys command asks for (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:airtouch5:<console>:ac<n>`   one device per AC (0-15);
//   `ext:<selector>:airtouch5:<console>:zone<n>` one device per zone (0-63);
//   <console>: the console id the AirTouch 5 gives in its UDP identification
//     answer ("AT5N2025...", lower case), chosen the first time the console
//     is read; when it does not answer that request then, the readable
//     fallback "a-" + the address typed (dots and colons as dashes): those
//     devices then follow the address. The choice is kept in /data.
//   <n>: the AC or zone number of the protocol.
// The feature keys and the option values are published forever.
//
// An AC: on/off (`air-conditioning/binary`: a "turn everything off" reaching
// it only stops the AC, the protective way), mode, fan speed, setpoint, the
// temperature it reads. A zone: on/off (same), damper opening (`fan/percent`),
// and with a sensor its setpoint and temperature. A device published again
// never loses a feature: those of the device created in Gladys are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { AC_FAN_SPEED, AC_MODE, FEATURES, KINDS, LIMITS, SETPOINT_FRAME } from './constants.js';
import { AC_NAME, FAN_NAMES, FEATURE_NAMES, MODE_NAMES, ZONE_NAME, word } from './i18n.js';
import { AC_MODE_CODE, FAN_CODE, setpointRange } from './airtouch/protocol.js';

/** Console mode -> Gladys AC_MODE, in display order, with the command code. */
export const MODE_MAP = [
  ['auto', AC_MODE.AUTO, AC_MODE_CODE.AUTO],
  ['cool', AC_MODE.COOLING, AC_MODE_CODE.COOL],
  ['heat', AC_MODE.HEATING, AC_MODE_CODE.HEAT],
  ['dry', AC_MODE.DRYING, AC_MODE_CODE.DRY],
  ['fan', AC_MODE.FAN, AC_MODE_CODE.FAN],
];
/**
 * Console fan speed -> Gladys AC_FAN_SPEED, with the command code. "Auto" is
 * the plain automatic speed, or the "intelligent auto" when the AC has only
 * that one. "Powerful" has no Gladys value: never offered nor sent, and a
 * read of it publishes no fan speed.
 */
export const FAN_MAP = [
  ['auto', AC_FAN_SPEED.AUTO, FAN_CODE.AUTO],
  ['quiet', AC_FAN_SPEED.QUIET, FAN_CODE.QUIET],
  ['low', AC_FAN_SPEED.LOW, FAN_CODE.LOW],
  ['medium', AC_FAN_SPEED.MID, FAN_CODE.MEDIUM],
  ['high', AC_FAN_SPEED.HIGH, FAN_CODE.HIGH],
  ['turbo', AC_FAN_SPEED.TURBO, FAN_CODE.TURBO],
];

export const toGladys = (table, value) => table.find((row) => row[0] === value)?.[1];
export const fromGladys = (table, value) => table.find((row) => row[1] === value)?.[0];

/** The modes an AC lists (all of them when its abilities are unknown). */
export const modesOf = (ability) =>
  MODE_MAP.filter(([name]) => !ability || ability.modes?.[name] === true).map(([name]) => name);

/** The fan speeds that can be sent to an AC (none when its abilities are unknown). */
export function fansOf(ability) {
  if (!ability) return [];
  return FAN_MAP.filter(([name]) =>
    name === 'auto'
      ? ability.fans.auto || ability.fans.intelligentAuto
      : ability.fans[name] === true,
  ).map(([name]) => name);
}

/** The code of a fan speed for an AC: "auto" is the intelligent one when it has only that. */
export function fanCode(ability, fan) {
  if (fan === 'auto' && ability && !ability.fans.auto && ability.fans.intelligentAuto) {
    return FAN_CODE.INTELLIGENT_AUTO;
  }
  return FAN_MAP.find((row) => row[0] === fan)?.[2];
}

export const modeCode = (mode) => MODE_MAP.find((row) => row[0] === mode)?.[2];

const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});
const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});

const options = (table, names, keep, language) =>
  table
    .filter(([name]) => keep.includes(name))
    .map(([name, value], index) => ({
      value,
      label: word(names[name], language),
      sort_order: index,
    }));

const TEMPERATURE = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -40,
  max: 60,
});

/** The setpoint bounds of an AC (the frame when its limits are unknown). */
export function boundsOf(ability) {
  return setpointRange(ability?.limits) ?? { ...SETPOINT_FRAME };
}

/** The features of an AC, by key, in display order. */
export function acDefinitions(ability, language) {
  const range = boundsOf(ability);
  return {
    [FEATURES.POWER]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.BINARY,
      min: 0,
      max: 1,
    }),
    [FEATURES.MODE]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.MODE,
      min: AC_MODE.AUTO,
      max: AC_MODE.FAN,
      supported_options: options(MODE_MAP, MODE_NAMES, modesOf(ability), language),
    }),
    [FEATURES.FAN]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.FAN_SPEED,
      min: AC_FAN_SPEED.AUTO,
      max: AC_FAN_SPEED.TURBO,
      supported_options: options(FAN_MAP, FAN_NAMES, fansOf(ability), language),
    }),
    [FEATURES.SETPOINT]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: range.min,
      max: range.max,
    }),
    [FEATURES.TEMPERATURE]: TEMPERATURE,
  };
}

/** The features of a zone, by key (setpoint and temperature only with a sensor). */
export function zoneDefinitions(range, hasSensor) {
  const defs = {
    [FEATURES.POWER]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.BINARY,
      min: 0,
      max: 1,
    }),
    [FEATURES.OPENING]: command({
      category: C.FAN,
      type: T.FAN.PERCENT,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    }),
  };
  if (hasSensor) {
    defs[FEATURES.SETPOINT] = command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: range.min,
      max: range.max,
    });
    defs[FEATURES.TEMPERATURE] = TEMPERATURE;
  }
  return defs;
}

const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/** The console part of the ids when the console id is unknown: "a-" + the address. */
export const fallbackId = (addressText) =>
  `a-${addressText.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 80);

export const deviceIds = (gladys, consoleKey, kind, number) =>
  gladys.externalIds('airtouch5', `${consoleKey}:${kind}${number}`);

const FEATURE_KEYS = Object.values(FEATURES);
const ID_RE = /:airtouch5:([a-z0-9-]{4,80}):(ac|zone)(\d{1,2})(?::([a-z-]{1,40}))?$/;

/** `{ console, kind, number, key? }` of one of our external ids (device or feature), else undefined. */
export function parseExternalId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = ID_RE.exec(externalId);
  if (!match) return undefined;
  const number = Number(match[3]);
  const kind = match[2];
  if (String(number) !== match[3] || number >= (kind === KINDS.AC ? LIMITS.acs : LIMITS.zones)) {
    return undefined;
  }
  if (match[4] !== undefined && !FEATURE_KEYS.includes(match[4])) {
    return undefined;
  }
  return { console: match[1], kind, number, key: match[4] };
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

const build = (ids, name, defs, params, language, created) =>
  keepCreatedFeatures(
    {
      name,
      external_id: ids.device,
      model: 'AirTouch 5',
      should_poll: false,
      features: Object.entries(defs).map(([key, def]) => ({
        name: word(FEATURE_NAMES[key], language),
        external_id: ids.feature(key),
        ...def,
      })),
      params,
    },
    created,
  );

/** The device of an AC. */
export function buildAc(gladys, { consoleKey, ability, number, version }, { language, created }) {
  const ids = deviceIds(gladys, consoleKey, KINDS.AC, number);
  const params = [
    { name: 'console', value: consoleKey },
    { name: 'ac', value: String(number) },
  ];
  if (version) params.push({ name: 'firmware', value: version });
  const name = ability?.name || word(AC_NAME(number), language);
  return build(ids, name, acDefinitions(ability, language), params, language, created);
}

/** The device of a zone. */
export function buildZone(
  gladys,
  { consoleKey, number, name, hasSensor, range, ac },
  { language, created },
) {
  const ids = deviceIds(gladys, consoleKey, KINDS.ZONE, number);
  const params = [
    { name: 'console', value: consoleKey },
    { name: 'zone', value: String(number) },
  ];
  if (ac !== undefined) params.push({ name: 'ac', value: String(ac) });
  return build(
    ids,
    name || word(ZONE_NAME(number), language),
    zoneDefinitions(range, hasSensor),
    params,
    language,
    created,
  );
}

const number = (n) => (Number.isFinite(n) ? { state: n } : undefined);
const binary = (b) => (typeof b === 'boolean' ? { state: b ? 1 : 0 } : undefined);
const roomTemperature = (t) =>
  Number.isFinite(t) && t >= -40 && t <= 60 ? { state: Math.round(t * 10) / 10 } : undefined;

function collect(ids, entries) {
  const states = [];
  for (const [key, value] of entries) {
    if (value !== undefined) {
      states.push({ device_feature_external_id: ids.feature(key), ...value });
    }
  }
  return states;
}

/** The current values of an AC (unknown values left out, never sent as undefined or NaN). */
export function acStates(ids, state) {
  return collect(ids, [
    [FEATURES.POWER, binary(state.on)],
    [FEATURES.MODE, number(toGladys(MODE_MAP, state.mode))],
    [FEATURES.FAN, number(toGladys(FAN_MAP, state.fan))],
    [FEATURES.SETPOINT, number(state.setpoint)],
    [FEATURES.TEMPERATURE, roomTemperature(state.temperature)],
  ]);
}

/** The current values of a zone. */
export function zoneStates(ids, state) {
  return collect(ids, [
    [FEATURES.POWER, binary(state.on)],
    [FEATURES.OPENING, number(state.percent)],
    [FEATURES.SETPOINT, state.hasSensor ? number(state.setpoint) : undefined],
    [FEATURES.TEMPERATURE, state.hasSensor ? roomTemperature(state.temperature) : undefined],
  ]);
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The change a command asks, checked on its own (before any read), or
 * undefined when the value is not one the feature takes:
 *   { field: 'on', value: boolean } | { field: 'mode', value } |
 *   { field: 'fan', value } | { field: 'setpoint', value, asked } |
 *   { field: 'percent', value }.
 * A setpoint is a multiple of 0.5 °C (checked on the value asked, never
 * rounded into a bound); a damper opening an integer from 0 to 100.
 */
export function commandValue(kind, key, value) {
  const n = strictNumber(value);
  if (n === undefined) {
    return undefined;
  }
  switch (key) {
    case FEATURES.POWER:
      return n === 0 || n === 1 ? { field: 'on', value: n === 1 } : undefined;
    case FEATURES.MODE: {
      const mode = kind === KINDS.AC ? fromGladys(MODE_MAP, n) : undefined;
      return mode === undefined ? undefined : { field: 'mode', value: mode };
    }
    case FEATURES.FAN: {
      const fan = kind === KINDS.AC ? fromGladys(FAN_MAP, n) : undefined;
      return fan === undefined ? undefined : { field: 'fan', value: fan };
    }
    case FEATURES.SETPOINT:
      return Number.isInteger(n * 2) ? { field: 'setpoint', value: n, asked: n } : undefined;
    case FEATURES.OPENING:
      return kind === KINDS.ZONE && Number.isInteger(n) && n >= 0 && n <= 100
        ? { field: 'percent', value: n }
        : undefined;
    default:
      return undefined;
  }
}
