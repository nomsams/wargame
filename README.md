# Wargame — Browser Preservation Edition

This workspace contains a safe, browser-native reconstruction of **Wargame 1.5.1**, originally released for iPhone OS 3.0. It runs as a static website and does not require Xcode, an Apple SDK, an emulator, or an Apple device.

**Play immediately online—no installation required:** [nomsams.github.io/wargame](https://nomsams.github.io/wargame/)

The playable build is in [`web`](./web). It includes:

- the original six factions and all 91 countries;
- the recovered vector world map and country adjacency graph;
- original faction balance, starting forces, cash, resources, and unit costs;
- queued buying, construction, movement, target-first multi-source attacks, naval troop transport, AI turns, income, and neutral growth;
- recovered yearly country-resource grants, Power Plant doubling, Petroleum discounts, and capital synergy bonuses;
- country and world upgrades, espionage, nuclear weapons, and Rail Gun;
- original-style battle zooms, grouped faction outcomes, and browser-decoded marching/combat sounds;
- three campaign objectives, victory/defeat, campaign log, autosave, and resume;
- an A–Z controlled-country force overview and responsive mouse, touch, and keyboard-accessible interface with settings and save-aware menu exit.

## Play locally

Install [Node.js](https://nodejs.org/) 20 or newer, open a terminal in this folder, and run:

```powershell
npm start
```

Then open [http://127.0.0.1:4317/](http://127.0.0.1:4317/). The server binds only to the local machine. Stop it with `Ctrl+C`.

No package installation is required: the game and server use only browser APIs and Node's standard library.

## Deploy

GitHub Pages publishes `main`; the root page immediately launches the static game in `web/`. Every push also runs the test suite. The IPA, extracted iOS application bundle, Internet Archive torrent, and source ZIP are intentionally retained only in the local archive and excluded from GitHub.

## Test

```powershell
npm test
```

The test suite verifies the recovered board geometry and country order, west/east map orientation, capital marker placement, anti-aliased country hit regions, faction setup, country-resource grants and synergy, purchase eligibility, naval boarding, battle reports, orders, upgrades, espionage, turn resolution, saved-game shape, asset references, all 534 normalized PNGs, and the decoded PCM combat audio.

## Workspace map

- `web/` — static playable game.
- `web/data/` — recovered game database and English localization.
- `web/assets/` — browser-normalized copies of original PNG and selected combat-audio resources.
- `preservation/source/ipa/` — safely extracted source IPA, retained for research and never loaded by the web game.
- `preservation/recovered/` — decoded faction, country, geometry, and localization records.
- `preservation/qa/` — rendered QA screenshots.
- `tools/` — read-only binary-plist, MCP, Mach-O, string, image, and CAF conversion tools plus the local server and browser regression test.

See [`PRESERVATION.md`](./PRESERVATION.md) for provenance, safety measures, recovery details, and known interpretation choices.

## Rights

This project is intended for software preservation, research, and private historical access. Original names, artwork, audio, text, and game design remain the property of their respective rights holders. No license is asserted over recovered original material.
