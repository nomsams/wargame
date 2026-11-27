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
- the recovered per-unit research tree, with one permanent specialization per unit type (Advanced Assault Rifle or Kevlar Vest, Sea Carrier or Advanced Battleship, Bomber or Stealth Aircraft, Multi-Warhead Missile or Explosive Device, Advanced Training Facility or Project Lazarus);
- original-style battle zooms, grouped faction outcomes, and browser-decoded marching/combat sounds;
- the fourteen recovered medals with their original artwork, awarded from their original conditions;
- five difficulty levels named for army ranks, from Private to General;
- three campaign objectives, victory/defeat, campaign log, autosave, portable save download/upload, native nearby sharing, and resume;
- an A–Z controlled-country force overview and responsive mouse, touch, and keyboard-accessible interface with settings and save-aware menu exit.

## Play locally

Install [Node.js](https://nodejs.org/) 20 or newer, open a terminal in this folder, and run:

```powershell
npm start
```

Then open [http://127.0.0.1:4317/](http://127.0.0.1:4317/). The server binds only to the local machine. Stop it with `Ctrl+C`.

No package installation is required. The QR encoder ships with the game and the server uses Node's standard library.

## Access and multiplayer

The app asks for `wargame` once per tab session. On public GitHub Pages this is an interface gate, so the files remain publicly accessible. To require authentication for every file on a self-hosted instance, set `WARGAME_HTTP_PASSWORD` before starting the server. The HTTP username is `wargame`. Keep the server on loopback and use an HTTPS reverse proxy if you expose it to other devices.

Choose **Multiplayer** to host a two-player game. Pick two different factions and show the invite QR to the guest. The guest opens the invite on their device, joins and sends their reply link back. Paste the reply in the original host tab, or scan the reply QR on the host device and forward it to that tab. Keep both game tabs open.

Both players plan independently. **Lock Orders** sends a commitment without sending the orders themselves. Both browsers reveal and resolve the orders after both players have locked. Choose **Head-to-head**, **Diplomacy**, or **Co-op against AI**. Co-op starts with a permanent player alliance and a shared victory objective.

The current draft and three recent checkpoints are saved separately for the host and guest in each browser. After a disconnect, open **Multiplayer → Reconnect saved host match** on the host and pair again from the original guest browser. The match resumes from the most recent checkpoint both browsers share. Starting a new match in the same role replaces that role's previous save. Pairing uses WebRTC and a public STUN server. Start on the same Wi-Fi, since some networks block direct connections.

## Alliance campaigns and turn replay

Enable **Alliances and logistics** in single-player setup or choose **Diplomacy** or **Co-op against AI** in multiplayer. Open the flag control on the map to offer or accept alliances and request help in a specific country. The AI can propose, accept, end, and act on alliances. Allies can fight together, move through allied holdings, and defend as visitors. After a joint capture, the faction with the most surviving troops gets ownership. Other participants retain control of their visiting units. Purchases are restricted to the owner and still follow the starting-country and Supply Center rules.

Supply runs to a friendly capital through friendly territory or escorted ports. A stronger hostile fleet at an adjacent port can cut sea supply. Isolated holdings pay a 20% unit surcharge, rounded up. The map draws arrows for queued and previewed moves. Select the destination to emphasize its incoming routes. Use **Turn replay** to step through or play back the latest year's movement and battle events.

The optional **Regional Coalitions** scenario is fictional. It replaces the Great Khalifa with Greater Israel (Syria, Saudi Arabia, and Turkey) and the Iranian Coalition (Iran, Iraq, and Yemen). Syria is the Greater Israel HQ because the board has no separate Israel tile.

## Deploy

GitHub Pages publishes `main`; the root page immediately launches the static game in `web/`. Every push also runs the test suite. The IPA, extracted iOS application bundle, Internet Archive torrent, and source ZIP are intentionally retained only in the local archive and excluded from GitHub.

## Test

```powershell
npm test
```

The test suite verifies the recovered unit research prices and effects, rival AI research, capital synergy reachability, map hit-test clamping, the medal catalogue and award conditions, save migration, the difficulty tiers, the recovered board geometry and country order, west/east map orientation, capital marker placement, anti-aliased country hit regions, faction setup, country-resource grants and synergy, purchase eligibility, naval boarding, battle reports, orders, upgrades, espionage, turn resolution, browser and portable save validation, asset references, all 534 normalized PNGs, and the decoded PCM combat audio.

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
