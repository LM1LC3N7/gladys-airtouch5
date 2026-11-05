// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An IPv4 address a console may have: never 0.0.0.0/8, a multicast or
 * reserved address (224 and over), nor an address ending in .255 (the
 * broadcast of the usual home networks).
 */
export function unicastIPv4(ip) {
  if (isIP(ip) !== 4) {
    return false;
  }
  const bytes = ip.split('.').map(Number);
  return bytes[0] !== 0 && bytes[0] < 224 && bytes[3] !== 255;
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (9005 by default). undefined when invalid.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (text === '' || text.length > 260 || /[^a-z0-9.:-]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unicastIPv4(host) ? { host, port } : undefined;
  }
  if (/^[\d.]+$/.test(host) || host.includes('..')) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") turns an option on: anything else, missing included, is off. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  const interval = Number(c.poll_interval);
  return {
    address,
    /** Something was typed that is not a valid address (never shown back). */
    invalid: typed !== '' && !address,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
