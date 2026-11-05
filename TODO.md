# TODO

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the first patch release gives 0.1.1.
  The manifest test checks the form and the agreement, never a fixed value.
- Reference: airtouch5py 0.5.1 of 2026-10-30 (Apache-2.0, Dave Leaver; LICENSE
  read in the repository), used by the Home Assistant `airtouch5` integration,
  and the frames of the Polyaire protocol document its tests carry. Logic
  ported to JavaScript, no Python dependency; notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image.
- Neighbour module followed: LM1LC3N7/gladys-coolmasternet (app, publisher,
  config, i18n structure); /data bounded as gladys-ipx800 0.1.3.
- No `keywords` nor `countries` in the manifest (AU, NZ in practice): the store
  does not take them yet. Category `climate` only.
- One console per installation, one TCP session to it at a time (port 9005),
  kept open: the console pushes its status changes on it. A new session opens
  only once the socket of the previous one is closed. One request in flight
  (no pipelining), by priority: stops, commands, reads.
- Reads: AC and zone status every interval (60 s, 30 to 600); AC abilities at
  each session and every 6 h (needed for the setpoint limits, modes, fan
  speeds); zone names and console version are secondary (a failure never stops
  the read). Failed sessions back off 30 s, 1, 2, 5 min, never under the
  interval. The attempt time is written to /data before the read, at most once
  a minute; a restart waits for the rest of the interval (at least a minute
  after the time kept).
- Identity: the UDP identification answer (console id), unicast to the address
  of the session from a socket bound to port 49005 (the Polyaire document,
  §2.a: the console answers to 49005; a free port when 49005 is taken, said in
  the status), taken from that address only, 3 tries of 1.5 s, at each session
  and at each read while unverified. Identifier rule (frozen, in
  `src/devices.js` and the docs): `airtouch5:<console id>:ac<n>` /
  `:zone<n>`; fallback `a-<address>` when the console did not answer the first
  time (or devices already exist under it), kept for good in /data. A console
  id seen later only checks the identity; once known, a session without it is
  "unverified" (nothing shown, only stops), another id is "another console".
  /data unreadable: only the id the created devices prove, nothing written.
- On/off as `air-conditioning/binary` for ACs and zones (as MELCloud,
  CoolMasterNet): a "turn everything off" reaching it only stops. Damper
  opening as `fan/percent` (0-100 %): no core category fits a zone damper
  better. Zone setpoint and temperature only for zones with a sensor.
- Stops (AC or zone off): see the header of `src/app.js`. Kept in /data (the
  save never awaited before the write), one frame for the ACs and one for the
  zones, 1.5 s for their answer, confirmed by a status read after the write;
  resent only by the answer of a status read written after it that shows the
  target on (never by the answer to the stop itself nor a push), one resend per
  such read, 3 at most (a write counts, nothing else); a confirmed stop lifted
  by two reads in a row showing the target on; any stop lifted by a "switch on"
  of the target that left (written even when the target already reads on);
  never by the time. A configuration with the same address (the first one after
  a start, a new interval) keeps the session a kept stop opened. A stop cuts a request
  in flight silent for 1 s (that read does not count as a failure).
- Other commands (3 s to be written, 3.5 s to be confirmed): the commands that
  arrive within 20 ms share one status read written after them, and the
  controls of one kind waiting go in one frame (each checked in `beforeSend`):
  a scene on 5 zones of a console answering in 900 ms is set in about 2 s. A
  request without answer closes the session (its late answer is never taken for
  another), except the zone names and version (asked by nothing else). Option
  checked on arrival and in `beforeSend`; /data must be
  writable (a stop could not be kept otherwise); decided on a fresh status;
  setpoint within the intersection of the cooling and heating limits read on
  the console (the reference warns the document labels them wrongly), to
  0.5 °C, refused outside; modes and fan speeds only those the AC lists;
  "powerful" fan speed neither offered nor shown (no Gladys value);
  "intelligent auto" shown as auto, and sent for auto when the AC has only it.
  Confirmed only by a status showing the value and different from the state
  before; otherwise "sent, without confirmation" and reads at 5 s and 20 s.
  A zone opening or setpoint is refused while a stop of that zone is not seen
  applied (it might open the zone again).

## Next

- Check on a real console: that the identification answer to port 49005
  crosses the container NAT (the request leaves from 49005, so its mapping should
  carry the answer back), that a control is answered
  by the status it changes, the message ids of the answers, and the number of
  TCP clients the console accepts.
- The AC error code (`AC status` byte 7-8 and the error information request) as
  a sensor; the zone low battery flag; the spill and bypass flags.
- Adopting a replaced console without deleting the data (the docs say how,
  today: uninstall and install again).

## Not verified

- Never tested with a real device: everything runs against a fake console
  built from the Polyaire document frames and airtouch5py.
- The UDP identification across the container NAT (see Next).
- In the sandbox Gladys, the container starts and connects (no console there).
- Mutation (r1 corrections): each correction has a test that fails when it is
  broken (`test/review.test.js`). Known equivalent mutants: the publisher
  budget check (its loop sends nothing when no room is left), the deadline of
  `beforeSend` (the lane wait already bounds it), `live()` without the identity
  (`consoleKey` covers it).
