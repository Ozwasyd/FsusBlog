#!/usr/bin/env python3
"""Audit a fixed v1 FSPT v3 patch and optional FHS2 v4 shard membership."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


ROLES = {"core": 0, "recent": 1, "archive": 2}
PATCH_HEADER = struct.Struct("<4s5I")
SHARD_HEADER = struct.Struct("<4s16If")
TERM = struct.Struct("<IfIIII")
DOCUMENT = struct.Struct("<IHHIIIIqIHHIHHIqIqI")
TAXON = struct.Struct("<IIHHI")
TAG_REF = struct.Struct("<H")
FSIM_HEADER = struct.Struct("<4sIiq")
INT32 = struct.Struct("<i")
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


@dataclass(frozen=True)
class ManifestShard:
    full_url: str
    full_sha256: str
    patch_url: str | None
    patch_sha256: str | None
    load_phase: int


@dataclass(frozen=True)
class Manifest:
    generation: str
    generated_ticks: int
    shards: dict[int, ManifestShard]
    initial_roles: tuple[str, ...]
    background_roles: tuple[str, ...]
    deep_roles: tuple[str, ...]
    root: str


def decode_manifest(data: bytes) -> Manifest:
    """Read the canonical fixed writer's FSIM binary v1, schema v4 profile."""
    if len(data) < FSIM_HEADER.size:
        raise PatchError("Truncated FSIM header")
    magic, binary, schema, ticks = FSIM_HEADER.unpack_from(data)
    if (magic, binary, schema) != (b"FSIM", 1, 4) or not 0 <= ticks <= 3155378975999999999:
        raise PatchError("Invalid FSIM v1 schema v4 header")
    at = FSIM_HEADER.size

    def integer() -> int:
        nonlocal at
        if at + INT32.size > len(data):
            raise PatchError("Truncated FSIM integer")
        value = INT32.unpack_from(data, at)[0]
        at += INT32.size
        return value

    def string() -> str:
        nonlocal at
        size = integer()
        if not 0 <= size <= 4096 or at + size > len(data):
            raise PatchError("Invalid FSIM string length")
        try:
            value = data[at:at + size].decode("utf-8")
        except UnicodeDecodeError as error:
            raise PatchError("Invalid FSIM UTF-8") from error
        at += size
        return value

    def optional_string() -> str | None:
        nonlocal at
        if at >= len(data) or data[at] not in (0, 1):
            raise PatchError("Invalid FSIM nullable string flag")
        present = data[at] == 1
        at += 1
        return string() if present else None

    def strings() -> tuple[str, ...]:
        count = integer()
        if not 0 <= count <= 32:
            raise PatchError("Invalid FSIM role list length")
        return tuple(string() for _ in range(count))

    generation = string()
    if not re.fullmatch(r"[0-9a-f]{16}", generation) or integer() != len(ROLES):
        raise PatchError("Invalid FSIM generation or shard count")
    shards = {}
    root = None
    for name, role in ROLES.items():
        if integer() != role:
            raise PatchError("FSIM roles must follow core, recent, archive order")
        shard = ManifestShard(string(), string(), optional_string(), optional_string(), integer())
        tail = f"/index.{name}.{generation}.bin"
        if not shard.full_url.endswith(tail) or not re.fullmatch(r"[0-9a-f]{64}", shard.full_sha256):
            raise PatchError("Invalid FSIM full shard URL or digest")
        shard_root = shard.full_url[:-len(tail)]
        if root is None:
            verify_manifest_root(shard_root)
            root = shard_root
        if shard_root != root or shard.load_phase != int(name == "archive"):
            raise PatchError("Invalid FSIM shard root or load phase")
        if (shard.patch_url is None) != (shard.patch_sha256 is None):
            raise PatchError("Incomplete FSIM patch URL or digest")
        if shard.patch_url is not None:
            patch_path = rf"{re.escape(root)}/patches/index\.{name}\.[0-9a-f]{{16}}-{generation}\.patch"
            if not re.fullmatch(patch_path, shard.patch_url) or not re.fullmatch(r"[0-9a-f]{64}", shard.patch_sha256):
                raise PatchError("Invalid FSIM patch URL or digest")
        shards[role] = shard

    phase_roles = strings(), strings(), strings()
    if phase_roles != (("core", "recent"), ("archive",), ()) or at != len(data):
        raise PatchError("Invalid FSIM role schedule or trailing bytes")
    return Manifest(generation, ticks, shards, *phase_roles, root)


def verify_manifest_root(root: str) -> None:
    if root == "/search":
        return
    release = re.fullmatch(r"/release-derived/([0-9]{14})-[0-9a-f]{12}/search", root)
    if release is None:
        raise PatchError("Invalid FSIM asset root")
    try:
        datetime.strptime(release[1], "%Y%m%d%H%M%S")
    except ValueError as error:
        raise PatchError("Invalid FSIM release timestamp") from error


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


def encode_patch(tombstones: list[int], appended: bytes) -> bytes:
    ids = bytearray()
    prior = 0
    for article in tombstones:
        if not prior < article <= UINT_MAX:
            raise PatchError("Declared tombstones must be unique ascending uint32 IDs")
        delta = article - prior
        while delta >= 128:
            ids.append((delta & 127) | 128)
            delta >>= 7
        ids.append(delta)
        prior = article
    return PATCH_HEADER.pack(b"FSPT", 3, len(tombstones), len(ids), len(appended), 0) + ids + appended


def verify_full_assets(manifest: Manifest, directory: Path, role: int | None) -> tuple[Shard, int] | None:
    generation = hashlib.sha256()
    selected = None
    for expected_role, row in manifest.shards.items():
        data, _ = read_artifact(directory / Path(row.full_url).name, row.full_sha256)
        generation.update(data)
        shard = decode_shard(data)
        if shard.role != expected_role:
            raise PatchError("Full FHS2 role does not match FSIM")
        if expected_role == role:
            selected = shard, len(data)
    if generation.hexdigest()[:16] != manifest.generation:
        raise PatchError("Full FHS2 assembly does not match the FSIM generation")
    return selected


def verify_declared_patch(data: bytes, base: Shard, target: Shard, target_bytes: int) -> Patch:
    patch = decode_patch(data)
    inserted = patch.appended.documents if patch.appended is not None else ()
    if not set(inserted).issubset(patch.tombstones):
        raise PatchError("A published FSPT mini shard needs declared tombstones for every upsert")
    target_count = max(len(target.documents), 1)
    if (not (inserted or patch.tombstones) or len(inserted) * 100 > target_count * 20 or
            len(patch.tombstones) * 100 > target_count * 15 or len(data) * 100 > max(target_bytes, 1) * 25):
        raise PatchError("FSPT patch falls outside the fixed writer's emission thresholds")
    if overlay(base, patch, target.role) != target:
        raise PatchError("FSPT document or posting membership does not match the target")
    return patch


def catalog_main() -> None:
    parser = argparse.ArgumentParser(description="Verify a fixed FSIM catalog and reproduce one declared FSPT patch offline.")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--assets", type=Path, required=True, help="directory holding the current search assets")
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--previous", type=Path, help="previous FSIM manifest for the declared role patch")
    parser.add_argument("--previous-assets", type=Path)
    parser.add_argument("--previous-manifest-sha256")
    parser.add_argument("--role", choices=ROLES)
    parser.add_argument("--emit", type=Path, help="reproduce a declared, pinned patch into a new file")
    parser.add_argument("--tombstone", type=int, action="append", default=[])
    parser.add_argument("--mini-shard", type=Path)
    args = parser.parse_args(sys.argv[2:])
    previous_args = (args.previous, args.previous_assets, args.role)
    if any(previous_args) != all(previous_args) or (args.previous_manifest_sha256 and args.previous is None):
        parser.error("Specify --previous, --previous-assets and --role together")
    if args.emit is not None and not (args.role and args.manifest_sha256 and args.previous_manifest_sha256 and args.tombstone):
        parser.error("Reproduction requires a role, both independent manifest SHA-256 values and declared tombstones")
    if args.emit is None and (args.tombstone or args.mini_shard is not None):
        parser.error("--tombstone and --mini-shard require --emit")

    try:
        manifest_bytes, digest = read_artifact(args.manifest, args.manifest_sha256)
        manifest = decode_manifest(manifest_bytes)
        role = ROLES[args.role] if args.role is not None else None
        current = verify_full_assets(manifest, args.assets, role)
        report = {"format": "FSIM binary v1 schema v4", "generation": manifest.generation,
                  "generatedAtTicks": manifest.generated_ticks, "assetRoot": manifest.root,
                  "manifestSha256": digest, "verifiedFullShards": len(manifest.shards), "rankingChecked": False}
        if current is not None:
            previous_bytes, previous_digest = read_artifact(args.previous, args.previous_manifest_sha256)
            previous = decode_manifest(previous_bytes)
            base, _ = verify_full_assets(previous, args.previous_assets, role)
            target, target_bytes = current
            row = manifest.shards[role]
            prefix = previous.shards[role].full_sha256[:16]
            expected = f"{manifest.root}/patches/index.{args.role}.{prefix}-{manifest.generation}.patch"
            if manifest.root != previous.root or row.patch_url != expected:
                raise PatchError("FSIM catalogs do not declare this exact role, base digest prefix and target")
            if args.emit is None:
                data, patch_digest = read_artifact(args.assets / "patches" / Path(expected).name, row.patch_sha256)
            else:
                mini = args.mini_shard.read_bytes() if args.mini_shard is not None else b""
                data = encode_patch(args.tombstone, mini)
                patch_digest = hashlib.sha256(data).hexdigest()
                if patch_digest != row.patch_sha256:
                    raise PatchError("Reproduced FSPT bytes do not match the pinned FSIM digest")
            patch = verify_declared_patch(data, base, target, target_bytes)
            if args.emit is not None:
                with tempfile.TemporaryDirectory(prefix=".fspt-", dir=args.emit.parent) as scratch:
                    staged = Path(scratch) / "patch"
                    staged.write_bytes(data)
                    os.link(staged, args.emit)
            report.update(previousManifestSha256=previous_digest, role=args.role,
                          baseFullSha256=previous.shards[role].full_sha256, targetFullSha256=row.full_sha256,
                          patchSha256=patch_digest, targetMembershipMatches=True, tombstones=patch.tombstones)
        print(json.dumps(report, ensure_ascii=False))
    except (OSError, PatchError, struct.error) as error:
        parser.exit(1, f"{error}\n")


def main() -> None:
    if sys.argv[1:2] == ["catalog"]:
        catalog_main()
        return
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
