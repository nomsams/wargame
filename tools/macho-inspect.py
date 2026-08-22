#!/usr/bin/env python3
"""Small, read-only Mach-O 32-bit inspector for the archived Wargame binary."""

from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from pathlib import Path


LC_SEGMENT = 0x1
LC_SYMTAB = 0x2


@dataclass
class Section:
    segment: str
    name: str
    address: int
    size: int
    offset: int


@dataclass
class Symbol:
    name: str
    address: int
    section: int
    kind: int


class MachO:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if self.data[:4] != b"\xce\xfa\xed\xfe":
            raise ValueError("Expected a 32-bit little-endian Mach-O")
        header = struct.unpack_from("<7I", self.data)
        self.cpu_type, self.cpu_subtype, self.file_type = header[1:4]
        self.command_count, self.command_bytes, self.flags = header[4:7]
        self.sections: list[Section] = []
        self.symbols: list[Symbol] = []
        symtab = None
        cursor = 28
        for _ in range(self.command_count):
            command, size = struct.unpack_from("<2I", self.data, cursor)
            if size < 8 or cursor + size > len(self.data):
                raise ValueError("Corrupt Mach-O load command")
            if command == LC_SEGMENT:
                fields = struct.unpack_from("<2I16s8I", self.data, cursor)
                segment_name = fields[2].split(b"\0", 1)[0].decode("ascii", "replace")
                section_count = fields[9]
                section_cursor = cursor + 56
                for _ in range(section_count):
                    values = struct.unpack_from("<16s16s9I", self.data, section_cursor)
                    name = values[0].split(b"\0", 1)[0].decode("ascii", "replace")
                    section_segment = values[1].split(b"\0", 1)[0].decode("ascii", "replace")
                    self.sections.append(Section(section_segment or segment_name, name, values[2], values[3], values[4]))
                    section_cursor += 68
            elif command == LC_SYMTAB:
                symtab = struct.unpack_from("<6I", self.data, cursor)[2:]
            cursor += size
        if symtab:
            symbol_offset, symbol_count, string_offset, string_size = symtab
            strings = self.data[string_offset:string_offset + string_size]
            for index in range(symbol_count):
                string_index, kind, section, _description, address = struct.unpack_from(
                    "<IBBHI", self.data, symbol_offset + index * 12
                )
                if string_index >= len(strings):
                    continue
                end = strings.find(b"\0", string_index)
                if end < 0:
                    continue
                name = strings[string_index:end].decode("utf8", "replace")
                if name:
                    self.symbols.append(Symbol(name, address, section, kind))
            self.symbols.sort(key=lambda item: item.address & ~1)

    def address_to_offset(self, address: int) -> int:
        address &= ~1
        for section in self.sections:
            if section.address <= address < section.address + section.size:
                return section.offset + address - section.address
        raise ValueError(f"Address 0x{address:x} is not in a file-backed section")

    def section(self, name: str) -> Section:
        matches = [section for section in self.sections if section.name == name or f"{section.segment},{section.name}" == name]
        if len(matches) != 1:
            raise ValueError(f"Expected one section named {name!r}, found {len(matches)}")
        return matches[0]

    def read_word(self, address: int) -> int:
        return struct.unpack_from("<I", self.data, self.address_to_offset(address))[0]

    def describe_address(self, address: int) -> str:
        names = sorted({symbol.name for symbol in self.symbols if symbol.address == address})
        if names:
            return "/".join(names[:3])
        for section in self.sections:
            if not (section.address <= address < section.address + section.size):
                continue
            if section.name in {"__cstring", "__ustring"}:
                offset = self.address_to_offset(address)
                if section.name == "__cstring":
                    end = self.data.find(b"\0", offset)
                    return repr(self.data[offset:end].decode("utf8", "replace"))
                end = offset
                while end + 1 < len(self.data) and self.data[end:end + 2] != b"\0\0":
                    end += 2
                return repr(self.data[offset:end].decode("utf-16le", "replace"))
            if section.name == "__cfstring" and address % 4 == 0:
                try:
                    pointer = self.read_word(address + 8)
                    return f"CFString({self.describe_address(pointer)})"
                except ValueError:
                    pass
            if section.name == "__objc_selrefs" and address % 4 == 0:
                try:
                    return f"selector({self.describe_address(self.read_word(address))})"
                except ValueError:
                    pass
            return f"{section.segment},{section.name}+0x{address - section.address:x}"
        return f"0x{address:08x}"


def disassemble(macho: MachO, symbol: Symbol, instruction_limit: int) -> None:
    vendor = Path(__file__).with_name("vendor")
    if vendor.is_dir():
        sys.path.insert(0, str(vendor))
    try:
        import capstone
    except ImportError as error:
        raise SystemExit("Capstone is required on PYTHONPATH for --disassemble") from error
    address = symbol.address & ~1
    next_addresses = [candidate.address & ~1 for candidate in macho.symbols if (candidate.address & ~1) > address]
    byte_count = min((min(next_addresses) - address) if next_addresses else 2048, 8192)
    file_offset = macho.address_to_offset(address)
    mode = capstone.CS_MODE_THUMB if symbol.address & 1 else capstone.CS_MODE_ARM
    engine = capstone.Cs(capstone.CS_ARCH_ARM, mode)
    print(f"{symbol.name} @ 0x{symbol.address:08x} ({'thumb' if symbol.address & 1 else 'arm'}, {byte_count} bytes)")
    import re
    for index, instruction in enumerate(engine.disasm(macho.data[file_offset:file_offset + byte_count], address)):
        annotation = ""
        match = re.fullmatch(r"([^,]+), \[pc(?:, #(-?0x[0-9a-f]+))?\]", instruction.op_str)
        if instruction.mnemonic.startswith("ldr") and match:
            displacement = int(match.group(2) or "0", 16)
            literal_address = instruction.address + 8 + displacement
            try:
                literal = macho.read_word(literal_address)
                annotation = f" ; [0x{literal_address:08x}]=0x{literal:08x} {macho.describe_address(literal)}"
                if any(section.name in {"__objc_selrefs", "__objc_classrefs", "__objc_superrefs"} and section.address <= literal < section.address + section.size for section in macho.sections):
                    pointed = macho.read_word(literal)
                    annotation += f" -> 0x{pointed:08x} {macho.describe_address(pointed)}"
            except (ValueError, struct.error):
                pass
        if instruction.mnemonic in {"bl", "blx"} and instruction.op_str.startswith("#0x"):
            target = int(instruction.op_str[1:], 16)
            annotation = f" ; {macho.describe_address(target)}"
        print(f"0x{instruction.address:08x}\t{instruction.mnemonic:8}\t{instruction.op_str}{annotation}")
        if index + 1 >= instruction_limit:
            break
        if instruction.mnemonic in {"bx", "pop"} and ("lr" in instruction.op_str or "pc" in instruction.op_str):
            break


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--sections", action="store_true")
    parser.add_argument("--symbols", metavar="TEXT")
    parser.add_argument("--disassemble", metavar="SYMBOL_TEXT")
    parser.add_argument("--address", type=lambda value: int(value, 0), help="disassemble an ARM address")
    parser.add_argument("--limit", type=int, default=300)
    args = parser.parse_args()
    macho = MachO(args.binary)
    print(
        f"Mach-O ARM subtype={macho.cpu_subtype} commands={macho.command_count} "
        f"sections={len(macho.sections)} symbols={len(macho.symbols)}"
    )
    if args.sections:
        for section in macho.sections:
            print(f"{section.segment:16} {section.name:20} addr=0x{section.address:08x} size=0x{section.size:x} file=0x{section.offset:x}")
    if args.symbols is not None:
        needle = args.symbols.casefold()
        for symbol in macho.symbols:
            if needle in symbol.name.casefold():
                print(f"0x{symbol.address:08x}\t{symbol.name}")
    if args.disassemble:
        needle = args.disassemble.casefold()
        matches = [symbol for symbol in macho.symbols if needle in symbol.name.casefold()]
        if not matches:
            raise SystemExit(f"No symbol contains {args.disassemble!r}")
        unique = {(symbol.address, symbol.name): symbol for symbol in matches}
        for symbol in list(unique.values())[:20]:
            disassemble(macho, symbol, args.limit)
    if args.address is not None:
        disassemble(macho, Symbol(f"address_0x{args.address:x}", args.address, 0, 0), args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
