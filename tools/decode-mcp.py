#!/usr/bin/env python3
"""Recover faction and country dictionaries from Wargame's worldmap.mcp.

The script only reads the MCP file. It locates length-prefixed binary property lists,
uses Python's standard plist decoder, and unwraps the old NSKeyedArchiver containers.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import plistlib
import struct
from pathlib import Path
from typing import Any


def uid_index(value: Any) -> int | None:
    return value.data if isinstance(value, plistlib.UID) else None


def unarchive(archive: dict[str, Any]) -> Any:
    objects = archive.get("$objects")
    top = archive.get("$top")
    if not isinstance(objects, list) or not isinstance(top, dict):
        return archive
    active: set[int] = set()

    def resolve(value: Any) -> Any:
        index = uid_index(value)
        if index is not None:
            if index < 0 or index >= len(objects):
                raise ValueError(f"Invalid keyed-archive UID {index}")
            if index in active:
                return {"$cycle": index}
            active.add(index)
            result = resolve(objects[index])
            active.remove(index)
            return result
        if isinstance(value, bytes):
            return {"base64": base64.b64encode(value).decode("ascii"), "length": len(value)}
        if isinstance(value, list):
            return [resolve(item) for item in value]
        if not isinstance(value, dict):
            return value
        if "NS.keys" in value and "NS.objects" in value:
            keys = resolve(value["NS.keys"])
            values = resolve(value["NS.objects"])
            return {str(key): item for key, item in zip(keys, values, strict=True)}
        if "NS.objects" in value:
            return resolve(value["NS.objects"])
        if "NS.data" in value:
            return resolve(value["NS.data"])
        return {key: resolve(item) for key, item in value.items() if not key.startswith("$")}

    root = top.get("root")
    return resolve(root)


def recover(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if len(data) > 100 * 1024 * 1024:
        raise ValueError("MCP exceeds the decoder's safety limit")
    marker = b"bplist00"
    records = []
    cursor = 0
    while True:
        offset = data.find(marker, cursor)
        if offset < 0:
            break
        if offset < 4:
            raise ValueError("Property list is missing its length prefix")
        length = struct.unpack_from("<I", data, offset - 4)[0]
        if length < 40 or offset + length > len(data):
            raise ValueError(f"Invalid property-list length {length} at {offset}")
        archive = plistlib.loads(data[offset:offset + length])
        root = unarchive(archive)
        records.append({"offset": offset, "length": length, "root": root})
        cursor = offset + length

    outline_vertex_count = struct.unpack_from("<I", data, 0)[0]
    geometry_cursor = 4 + outline_vertex_count * 6
    country_geometry_count = struct.unpack_from("<I", data, geometry_cursor)[0]
    geometry_cursor += 4
    highlight_offsets = list(struct.unpack_from(f"<{country_geometry_count}I", data, geometry_cursor))
    geometry_cursor += country_geometry_count * 4
    highlight_lengths = list(struct.unpack_from(f"<{country_geometry_count}I", data, geometry_cursor))
    geometry_cursor += country_geometry_count * 4
    fill_vertex_count = struct.unpack_from("<I", data, geometry_cursor)[0]
    geometry_cursor += 4
    fill_vertices = []
    for index in range(fill_vertex_count):
        x, y, red, green, blue, alpha = struct.unpack_from("<hhBBBB", data, geometry_cursor + index * 8)
        fill_vertices.append([x, y, red, green, blue, alpha])
    geometry_cursor += fill_vertex_count * 8
    fill_index_count = struct.unpack_from("<I", data, geometry_cursor)[0]
    geometry_cursor += 4
    fill_indices = list(struct.unpack_from(f"<{fill_index_count}H", data, geometry_cursor))
    geometry_cursor += fill_index_count * 2
    range_names = ("vertexOffsets", "vertexLengths", "indexOffsets", "indexLengths")
    ranges = {}
    for name in range_names:
        ranges[name] = list(struct.unpack_from(f"<{country_geometry_count}I", data, geometry_cursor))
        geometry_cursor += country_geometry_count * 4
    half_size = list(struct.unpack_from("<2f", data, geometry_cursor))

    factions = []
    countries = []
    other = []
    for record in records:
        root = record["root"]
        if isinstance(root, dict) and "factionName" in root:
            factions.append(root)
        elif isinstance(root, dict) and "name" in root and "adjoiningCountries" in root:
            countries.append(root)
        else:
            other.append(record)
    if len(countries) != country_geometry_count:
        raise ValueError(
            f"Geometry describes {country_geometry_count} countries but archives contain {len(countries)}"
        )
    map_countries = []
    for index, country in enumerate(countries):
        vertex_start = ranges["vertexOffsets"][index] // 8
        vertices = fill_vertices[vertex_start:vertex_start + ranges["vertexLengths"][index]]
        center_x = sum(vertex[0] for vertex in vertices) / max(1, len(vertices))
        center_y = sum(vertex[1] for vertex in vertices) / max(1, len(vertices))
        map_countries.append({
            "name": country["name"],
            "vertexStart": vertex_start,
            "vertexLength": ranges["vertexLengths"][index],
            "indexStart": ranges["indexOffsets"][index],
            "indexLength": ranges["indexLengths"][index],
            "highlightStart": highlight_offsets[index],
            "highlightLength": highlight_lengths[index],
            "center": [round(center_x, 2), round(center_y, 2)],
        })
    return {
        "source": path.name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "recordCount": len(records),
        "factions": factions,
        "countries": countries,
        "map": {
            "halfSize": half_size,
            "vertices": fill_vertices,
            "indices": fill_indices,
            "countries": map_countries,
        },
        "unclassified": other,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    recovered = recover(args.input)
    text = json.dumps(recovered, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        print(
            f"Recovered {len(recovered['factions'])} factions and "
            f"{len(recovered['countries'])} countries into {args.output}"
        )
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
