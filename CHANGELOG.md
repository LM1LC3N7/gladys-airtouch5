# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-05

### Added

- First version: the air conditioners and zones of an AirTouch 5 console
  (Polyaire) over its local TCP protocol, one connection at a time: on/off,
  mode, fan speed, setpoint (within the limits read on the console), damper
  opening and temperatures; the statuses the console sends by itself shown as
  they come.
- Identity of the console (UDP identification) checked at every connection;
  devices named after its console id, or after the address when it does not
  give it the first time.
- Stops never refused: sent first, kept in `/data` until a read shows them,
  sent again by the reads that contradict them (3 times at most).
- Other commands behind the "Allow the commands" option, off by default.

[Unreleased]: https://github.com/LM1LC3N7/gladys-airtouch5/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-airtouch5/releases/tag/v0.1.1
