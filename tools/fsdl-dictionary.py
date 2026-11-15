#!/usr/bin/env python3
"""Export or verify the fixed search lexicon in the v1 FSDL v2 format."""

import argparse
import hashlib
import json
import os
import struct
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


LEXICON = Path(__file__).resolve().parents[1] / "src/Contracts/search-lexicon.json"
NO_TERMINAL = 0xFFFFFFFF
HEADER = struct.Struct("<4sIIII")
NODE = struct.Struct("<IIII")
EDGE = struct.Struct("<II")
ENTRY = struct.Struct("<IHHII")
SIZE = struct.Struct("<I")


@dataclass
class TrieNode:
    children: dict[int, int] = field(default_factory=dict)
    terminal: int = NO_TERMINAL


def unique_object(fields):
    value = {}
    for key, item in fields:
        if key in value:
            raise ValueError(f"Duplicate lexicon field: {key}")
        value[key] = item
    return value


def compile_lexicon(source: object) -> bytes:
    if not isinstance(source, dict) or set(source) != {"words", "stopwords"}:
        raise ValueError("Expected the shared search lexicon with words and stopwords")
    weights, stops = source["words"], source["stopwords"]
    if not isinstance(weights, dict) or not isinstance(stops, list):
        raise ValueError("Invalid lexicon tables")
    if any(type(weight) is not int or not 1 <= weight <= 0x7FFFFFFF for weight in weights.values()):
        raise ValueError("Invalid lexicon frequency")
    if any(not isinstance(term, str) or not term for term in [*weights, *stops]):
        raise ValueError("Invalid lexicon term")
    stopwords = set(stops)
    if len(stops) != len(stopwords):
        raise ValueError("Duplicate stopword")

    ordered = sorted((term.encode("utf-8"), term) for term in weights.keys() | stopwords)
    nodes = [TrieNode()]
    records = bytearray()
    strings = bytearray()
    for index, (encoded, term) in enumerate(ordered):
        if len(encoded) > 0xFFFF:
            raise ValueError("Lexicon term exceeds the FSDL byte field")
        current = 0
        for character in term:
            scalar = ord(character)
            children = nodes[current].children
            child = children.get(scalar)
            if child is None:
                child = len(nodes)
                children[scalar] = child
                nodes.append(TrieNode())
            current = child
        nodes[current].terminal = index
        records.extend(ENTRY.pack(len(strings), len(encoded), int(term in stopwords), weights.get(term, 1), len(term)))
        strings.extend(encoded)

    node_records = bytearray()
    edges = bytearray()
    for node in nodes:
        node_records.extend(NODE.pack(len(edges) // EDGE.size, len(node.children), node.terminal, 0))
        for scalar, target in sorted(node.children.items()):
            edges.extend(EDGE.pack(scalar, target))

    return b"".join((HEADER.pack(b"FSDL", 2, len(nodes), len(edges) // EDGE.size, len(ordered)),
                     node_records, edges, records, SIZE.pack(len(strings)), strings))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("export", "verify"))
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    try:
        with LEXICON.open(encoding="utf-8") as source:
            data = compile_lexicon(json.load(source, object_pairs_hook=unique_object))
        if args.command == "export":
            with tempfile.TemporaryDirectory(prefix=".fsdl-", dir=args.artifact.parent) as scratch:
                staged = Path(scratch) / "dictionary"
                staged.write_bytes(data)
                os.link(staged, args.artifact)
        else:
            with args.artifact.open("rb") as artifact:
                if artifact.read(len(data) + 1) != data:
                    raise ValueError("FSDL artifact differs from the exact shared lexicon")
    except (OSError, ValueError, struct.error) as error:
        parser.exit(1, f"{error}\n")
    print(f"fsdl_v2_bytes={len(data)} sha256={hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
