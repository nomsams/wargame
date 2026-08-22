# Preservation record

## Source and identity

- Internet Archive item: <https://archive.org/details/Wargame_1.5.1_ios_3.0>
- App: Wargame
- Version: 1.5.1
- Bundle ID: `com.jemast.Wargame`
- Minimum OS: iPhone OS 3.0
- Original executable architecture: 32-bit ARMv6 Mach-O
- IPA SHA-256: `f444b247928a779a745d1123234183dc20b8c0afa76e1c6730a0559d2488d280`
- `worldmap.mcp` SHA-256: `eea4276cbd31d80fc9a65265733faadeb251fe583b6ecc9fdac0f5eee4ff57fb`

The extracted Archive.org metadata is retained beside the original IPA in `Wargame_1.5.1_ios_3.0/`.

## Safety process

The archived app was treated as untrusted input.

1. The IPA was opened only as a ZIP container. Before extraction, every entry was resolved against the designated extraction root and rejected if rooted or able to escape it.
2. Per-entry size, total expansion size, and compression ratios were bounded before data was written.
3. The archive expanded to 605 entries and 11,455,027 bytes. No extracted scripts or binaries were launched.
4. The ARM Mach-O executable was examined only with string extraction, structure parsing, symbol-table reading, and Capstone static disassembly.
5. The browser app does not contain, load, emulate, or execute the Mach-O binary, NIB files, entitlements, torrent, SQLite metadata, or arbitrary archive content.
6. Only decoded JSON and normalized PNG copies cross into `web/`. Browser paths are fixed; no path or HTML input is accepted from archive data at runtime.
7. Campaigns remain in browser `localStorage`. The playable app makes no network requests after its static files are loaded.

## Recovered material

The proprietary `worldmap.mcp` format was reconstructed from its import routine and byte layout. It contains:

- 31,950 anti-aliased outline vertices;
- 91 country draw ranges;
- 5,542 fill vertices and 14,670 triangle indices;
- map extents and display buffers;
- six length-prefixed `NSKeyedArchiver` faction dictionaries;
- 91 length-prefixed country dictionaries.

The dictionaries yielded the original faction capitals, colors, available-upgrade bitfields, unit attack/defence/cost profiles, starting cash, country names, owners, starting units, resources, income, neutral growth, continents, sea access, and adjacency.

The original coordinate stream stores longitude west-positive. The browser projection explicitly inverts that axis so the Americas render on the left and Asia/Oceania on the right. Its hidden country-picking canvas uses complementary-channel IDs so anti-aliased coastlines and narrow triangles still resolve to the correct country.

Apple's optimized `CgBI` PNGs were decoded without altering the extracted originals. The converter unfilters raw scanlines, converts premultiplied BGRA pixels to straight RGBA, removes the private chunk, recompresses standard IDAT data, and writes valid CRCs. All 534 top-level images are retained as standard PNGs in `web/assets/`.

The English and French binary localization plists are decoded in `preservation/recovered/`. The browser UI currently uses English text; the French database is retained for a future complete interface translation.

## Balance recovered from code

Static disassembly recovered the full 22-slot upgrade enum and cost switch, including the unused slot, as well as the faction availability bitfields. Examples include AWFDS ($50), Supply Center ($100), faction country abilities ($30), Manhattan Project ($1,000), Grand Marshal ($2,000), end-tier upgrades ($3,000), and Rail Gun ($4,000). Resource IDs were matched to Petroleum, Heavy Industry, Finance, Agriculture, Ore, and Fishing.

## Reconstruction choices

Some high-level behavior could not be recovered perfectly without executing the obsolete build. Those parts are clean-room interpretations designed to preserve the documented play loop:

- combat uses recovered unit strength plus bounded seeded battlefield variance;
- actions resolve in construction, buying, then movement order at year end;
- the AI uses the recovered map and balance data with deterministic heuristics;
- resource-specific purchase discounts are inferred from the original resource manager and descriptions;
- network/Bluetooth/Ladder services are intentionally not contacted or emulated;
- original CAF audio remains in the extracted preservation source but is not exposed to browsers because the obsolete encoding is not broadly supported.

These choices are isolated in `web/src/engine.js` and can be refined as more historical evidence appears. The recovered raw data remains separate from game logic so later researchers can replace interpretations without repeating extraction.

## Reproducing the static analysis

The plist, MCP, Mach-O, string, and PNG utilities are source-controlled in `tools/`. Only Mach-O disassembly needs an external analysis dependency:

```powershell
python -m pip install --target tools/vendor -r tools/requirements-analysis.txt
```

That dependency is not needed to run or test the browser game and is excluded from version control.
