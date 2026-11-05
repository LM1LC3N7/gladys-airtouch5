# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/stops.test.js            # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js), before connect()
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        the integration: reads, identity, devices, states, stops, commands
src/lane.js                       the one lane of requests, by priority (stops, commands, reads)
src/airtouch/protocol.js          the binary protocol, pure (frames, CRC, requests, answers)
src/airtouch/session.js           one TCP session (bounded reads, one request at a time)
src/airtouch/discovery.js         the UDP identity of the console (unicast)
src/devices.js                    ACs and zones -> Gladys devices; external ids (frozen rule)
src/publisher.js                  states to Gladys within 300 per minute
src/store.js                      /data: address, ids, attempt time, stops kept (bounded)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       runtime texts (English and French)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: fake Gladys, fake console on a real local socket
scripts/cover.mjs                 generates cover.png (800x534, plain Node)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Logic ported from airtouch5py (Apache-2.0): keep `THIRD_PARTY_NOTICES.md` up to
date. Stops are never refused nor blocked (see the header of `src/app.js` for the
exact rules); other commands stay off by default. Reads are never sooner than
the interval. The protocol has no password: the docs say to keep the console on
a trusted network.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, feature keys, option values.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume, and never wait on it without a bound.
- **Two clocks.** `now` (wall) only dates what `/data` keeps; every pace,
  deadline and guard runs on `monotonic`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): command errors,
  statuses, manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1, and every wait in
  them is bounded.
