#!/usr/bin/env python3
"""Audit a fixed v1 FSPT v3 patch and optional FHS2 v4 shard membership."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path


ROLES = {"core": 0, "recent": 1, "archive": 2}
PATCH_HEADER = struct.Struct("<4s5I")
SHARD_HEADER = struct.Struct("<4s16If")
TERM = struct.Struct("<IfIIII")
DOCUMENT = struct.Struct("<IHHIIIIqIHHIHHIqIqI")
TAXON = struct.Struct("<IIHHI")
TAG_REF = struct.Struct("<H")
UINT_MAX = (1 << 32) - 1


class PatchError(ValueError):
    pass


@dataclass(frozen=True)
class Shard:
    role: int
    documents: tuple[int, ...]
    postings: dict[int, tuple[int, ...]]


@dataclass(frozen=True)
class Patch:
    tombstones: tuple[int, ...]
    appended: Shard | None


def read_varint(data: memoryview, offset: int, end: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 35, 7):
        if offset >= end:
            raise PatchError("Truncated uint32 varint")
        byte = data[offset]
        offset += 1
        if shift == 28 and byte > 0x0F:
            raise PatchError("Uint32 varint overflows")
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            if shift and not byte:
                raise PatchError("Noncanonical uint32 varint")
            return value, offset
    raise PatchError("Uint32 varint overflows")


def next_article(data: memoryview, offset: int, end: int, previous: int) -> tuple[int, int]:
    delta, offset = read_varint(data, offset, end)
    if delta <= 0 or previous + delta > UINT_MAX:
        raise PatchError("Article ID delta must increase without overflow")
    return previous + delta, offset


def decode_patch(data: bytes | memoryview) -> Patch:
    data = memoryview(data)
    if len(data) < PATCH_HEADER.size:
        raise PatchError("Truncated FSPT header")
    magic, version, count, tombstone_bytes, shard_bytes, reserved = PATCH_HEADER.unpack_from(data)
    offset = PATCH_HEADER.size
    end = offset + tombstone_bytes
    if magic != b"FSPT" or version != 3 or reserved:
        raise PatchError("Invalid FSPT v3 header")
    if count > tombstone_bytes or end + shard_bytes != len(data):
        raise PatchError("Invalid FSPT section lengths")

    tombstones = []
    article = 0
    for _ in range(count):
        article, offset = next_article(data, offset, end, article)
        tombstones.append(article)
    if offset != end:
        raise PatchError("FSPT tombstone count does not consume the section")
    return Patch(tuple(tombstones), decode_shard(data[end:]) if shard_bytes else None)


def align8(offset: int) -> int:
    return (offset + 7) & ~7


def decode_shard(data: bytes | memoryview) -> Shard:
    data = memoryview(data)
    if len(data) < SHARD_HEADER.size:
        raise PatchError("Truncated FHS2 header")
    (magic, version, role, flags, term_count, doc_count, category_count, tag_count, tag_ref_count,
     terms_at, docs_at, cats_at, tags_at, refs_at, strings_at, postings_at, posting_bytes,
     mean_length) = SHARD_HEADER.unpack_from(data)
    if (magic != b"FHS2" or version != 4 or role not in ROLES.values() or flags != int(role == ROLES["core"])
            or not math.isfinite(mean_length) or mean_length <= 0):
        raise PatchError("Invalid FHS2 v4 header")
    if postings_at + posting_bytes != len(data) or strings_at > postings_at or postings_at % 8:
        raise PatchError("Invalid FHS2 string or posting section lengths")
    # The fixed writer aligns every section, leaving padding zeroed.
    previous_end = SHARD_HEADER.size
    for start, count, size in ((terms_at, term_count, TERM.size), (docs_at, doc_count, DOCUMENT.size),
                               (cats_at, category_count, TAXON.size), (tags_at, tag_count, TAXON.size),
                               (refs_at, tag_ref_count, TAG_REF.size), (strings_at, 0, 0)):
        if (start != align8(previous_end) or start + count * size > postings_at
                or any(data[previous_end:start])):
            raise PatchError("Invalid FHS2 section alignment or bounds")
        previous_end = start + count * size

    string_used = 0

    def string_slice(offset: int, size: int) -> None:
        nonlocal string_used
        if offset + size > postings_at - strings_at or (size and offset != string_used):
            raise PatchError("Invalid FHS2 string slice")
        try:
            bytes(data[strings_at + offset:strings_at + offset + size]).decode("utf-8")
        except UnicodeDecodeError as error:
            raise PatchError("Invalid FHS2 UTF-8") from error
        string_used += size

    for count, start in ((category_count, cats_at), (tag_count, tags_at)):
        for index in range(count):
            _, name_at, length, reserved16, reserved32 = TAXON.unpack_from(data, start + index * TAXON.size)
            if reserved16 or reserved32:
                raise PatchError("Invalid FHS2 taxonomy reserved fields")
            string_slice(name_at, length)

    documents = []
    tags_seen = 0
    for index in range(doc_count):
        (article, category, tags, tag_start, _, _, _, _, title_at, title_length, title_reserved,
         summary_at, summary_length, summary_reserved, reserved, _, _, _, _) = DOCUMENT.unpack_from(
            data, docs_at + index * DOCUMENT.size)
        category_outside = category >= category_count and category != 0xFFFF and not (category_count == category == 0)
        if (not article or (documents and article <= documents[-1]) or
                category_outside or tag_start != tags_seen or
                tag_start + tags > tag_ref_count or title_reserved or summary_reserved or reserved):
            raise PatchError("Invalid FHS2 document metadata")
        for ref in range(tag_start, tag_start + tags):
            if TAG_REF.unpack_from(data, refs_at + ref * TAG_REF.size)[0] >= tag_count:
                raise PatchError("Invalid FHS2 tag reference")
        tags_seen += tags
        string_slice(title_at, title_length)
        string_slice(summary_at, summary_length)
        documents.append(article)
    if (tags_seen != tag_ref_count or postings_at != align8(strings_at + string_used) or
            any(data[strings_at + string_used:postings_at])):
        raise PatchError("Unconsumed FHS2 tag references or string bytes")

    allowed_documents = set(documents)
    postings = {}
    previous_hash = -1
    consumed = 0
    for index in range(term_count):
        term, idf, offset, length, term_flags, reserved = TERM.unpack_from(data, terms_at + index * TERM.size)
        if (term <= previous_hash or not math.isfinite(idf) or idf < 0 or offset != consumed or
                not length or offset + length > posting_bytes or term_flags not in (0, 1) or reserved):
            raise PatchError("Invalid FHS2 term metadata")
        postings[term] = decode_postings(data, postings_at + offset, postings_at + offset + length,
                                         allowed_documents, bool(term_flags))
        previous_hash = term
        consumed += length
    if consumed != posting_bytes:
        raise PatchError("Unconsumed FHS2 posting bytes")
    return Shard(role, tuple(documents), postings)


def decode_postings(data: memoryview, offset: int, end: int, documents: set[int], positional: bool) -> tuple[int, ...]:
    count, offset = read_varint(data, offset, end)
    if not count or count > (end - offset) // 5:
        raise PatchError("Invalid FHS2 posting count")
    ids = []
    article = 0
    for _ in range(count):
        article, offset = next_article(data, offset, end, article)
        if article not in documents or offset + 3 >= end or not any(data[offset:offset + 3]):
            raise PatchError("Invalid FHS2 posting document or frequency")
        offset += 3
        positions, offset = read_varint(data, offset, end)
        if (positions and not positional) or positions > (end - offset) // 3:
            raise PatchError("Invalid FHS2 posting position count")
        position = 0
        for _ in range(positions):
            delta, offset = read_varint(data, offset, end)
            width, offset = read_varint(data, offset, end)
            field, offset = read_varint(data, offset, end)
            position += delta
            if width <= 0 or position + width > UINT_MAX or field not in (1, 2, 3, 4):
                raise PatchError("Invalid FHS2 posting position")
        ids.append(article)
    if offset != end:
        raise PatchError("FHS2 posting count does not consume the section")
    return tuple(ids)


def overlay(base: Shard, patch: Patch, role: int) -> Shard:
    """Combine one role's posting membership, without evaluating rank or global display metadata."""
    added = patch.appended
    if role not in ROLES.values() or base.role != role or (added is not None and added.role != role):
        raise PatchError("The base and appended shard must match the supplied role")
    removed = set(patch.tombstones)
    documents = set(base.documents) - removed
    postings = {term: set(ids) - removed for term, ids in base.postings.items()}
    if added is not None:
        documents.update(added.documents)
        for term, ids in added.postings.items():
            postings.setdefault(term, set()).update(ids)
    return Shard(role, tuple(sorted(documents)),
                 {term: tuple(sorted(ids)) for term, ids in sorted(postings.items()) if ids})


def read_artifact(path: Path, expected_sha256: str | None = None) -> tuple[bytes, str]:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha256 is not None and expected_sha256.lower() != digest:
        raise PatchError("Artifact does not match the supplied SHA-256")
    return data, digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("patch", type=Path)
    parser.add_argument("--role", choices=ROLES)
    parser.add_argument("--patch-sha256")
    parser.add_argument("--base", type=Path, help="previous full FHS2 shard")
    parser.add_argument("--base-sha256")
    parser.add_argument("--target", type=Path, help="compare membership with a full rebuilt FHS2 shard")
    args = parser.parse_args()
    if args.base is None and (args.target is not None or args.base_sha256 is not None):
        parser.error("--target and --base-sha256 require --base")

    try:
        data, digest = read_artifact(args.patch, args.patch_sha256)
        patch = decode_patch(data)
        added = patch.appended
        role = ROLES[args.role] if args.role is not None else (added.role if added is not None else None)
        if added is not None and added.role != role:
            raise PatchError("The appended shard has a different role")
        report = {
            "format": "FSPT v3", "bytes": len(data), "patchSha256": digest,
            "tombstones": patch.tombstones, "appendedDocuments": added.documents if added is not None else (),
            "appendedWithoutTombstone": sorted(set(added.documents) - set(patch.tombstones)) if added is not None else [],
            "rankingChecked": False,
        }
        if args.base is not None:
            base_bytes, base_digest = read_artifact(args.base, args.base_sha256)
            base = decode_shard(base_bytes)
            role = base.role if role is None else role
            merged = overlay(base, patch, role)
            report.update(baseSha256=base_digest, mergedDocuments=len(merged.documents), mergedTerms=len(merged.postings))
            if args.target is not None:
                target_bytes, target_digest = read_artifact(args.target)
                target = decode_shard(target_bytes)
                if target.role != role:
                    raise PatchError("The target shard has a different role")
                report.update(targetSha256=target_digest, targetMembershipMatches=(merged == target))
        report["role"] = next((name for name, value in ROLES.items() if value == role), None)
        print(json.dumps(report, ensure_ascii=False))
        if report.get("targetMembershipMatches") is False:
            raise SystemExit(1)
    except (OSError, PatchError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
