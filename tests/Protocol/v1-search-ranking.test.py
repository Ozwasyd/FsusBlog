#!/usr/bin/env python3
"""Source-derived oracle for the fixed v1 raw FSR4 ABI on trusted full-shard fixtures."""

from __future__ import annotations

import json
import math
import re
import struct
import unittest
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path


FIXTURES = Path(__file__).with_name("fixtures")
U32 = struct.Struct("<I")
U32_MASK = (1 << 32) - 1
DOCUMENT = struct.Struct("<IHHIIIIqIHHIHHIqIqI")
TERM = struct.Struct("<IfIIII")
TAXON = struct.Struct("<IIHHI")
RESULT = struct.Struct("<4s5I")
TF_VALUES = (*range(11), 12, 15, 20, 30, 50, 100, 140)
AGE_SCALE = 1.0 / (1000 * 60 * 60 * 24 * 45)
CJK_RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x3040, 0x30FF), (0xAC00, 0xD7AF))


def rotate32(value: int, count: int) -> int:
    value &= U32_MASK
    return ((value << count) | (value >> (32 - count))) & U32_MASK


def murmur3(data: bytes) -> int:
    def mixed(block: bytes) -> int:
        rotated = rotate32(int.from_bytes(block, "little") * 0xCC9E2D51, 15)
        return (rotated * 0x1B873593) & U32_MASK

    digest = 0
    whole = len(data) & ~3
    for at in range(0, whole, 4):
        digest = (rotate32(digest ^ mixed(data[at:at + 4]), 13) * 5 + 0xE6546B64) & U32_MASK
    digest ^= mixed(data[whole:]) ^ len(data)
    digest = ((digest ^ (digest >> 16)) * 0x85EBCA6B) & U32_MASK
    digest = ((digest ^ (digest >> 13)) * 0xC2B2AE35) & U32_MASK
    return digest ^ (digest >> 16)


def query_hashes(query: str) -> list[int]:
    tokens = re.findall(r"[a-zA-Z0-9]+|[^\x00-\x7f]", query)
    return sorted({murmur3(token.lower().encode("ascii") if token.isascii() else token.encode("utf-8"))
                   for token in tokens if token.isascii() or any(low <= ord(token) <= high for low, high in CJK_RANGES)})


@dataclass(frozen=True)
class Document:
    id: int
    views: int
    comments: int
    length: int
    published_ms: int
    category: tuple[int, bytes]
    title: bytes
    summary: bytes
    tags: tuple[tuple[int, bytes], ...]
    coordinates: tuple[int, int, int, int]


@dataclass(frozen=True)
class Posting:
    frequency: tuple[int, int, int]
    positions: tuple[tuple[int, int, int], ...]


@dataclass(frozen=True)
class Term:
    idf: float
    positional: bool
    postings: dict[int, Posting]


@dataclass(frozen=True)
class Shard:
    mean_length: float
    terms: dict[int, Term]


def read_postings(data: bytes, at: int, end: int) -> dict[int, Posting]:
    def variable() -> int:
        nonlocal at
        value = 0
        for shift in range(0, 35, 7):
            assert at < end
            byte = data[at]
            at += 1
            value += (byte & 127) << shift
            if byte < 128:
                return value
        raise AssertionError("Invalid fixture varint")

    postings = {}
    article = 0
    for _ in range(variable()):
        article += variable()
        frequencies = tuple(data[at:at + 3])
        at += 3
        position = 0
        positions = []
        for _ in range(variable()):
            position += variable()
            positions.append((position, max(variable(), 1), variable()))
        postings[article] = Posting(frequencies, tuple(positions))
    assert at == end
    return postings


def load_full_package(data: bytes) -> tuple[dict[int, Document], list[Shard]]:
    """Read the fixed fixture's complete roles in package order; no FSPT overlays."""
    magic, version, count = struct.unpack_from("<4sII", data)
    assert (magic, version) == (b"FSPK", 4)
    documents = {}
    shards = []
    for index in range(count):
        kind, role, start, size = struct.unpack_from("<4I", data, 12 + 16 * index)
        assert kind == 0
        shard = data[start:start + size]
        (magic, version, key, flags, term_count, document_count, category_count, tag_count, _,
         term_offset, doc_offset, category_offset, tag_offset, refs_offset, strings_offset, posting_offset,
         _, mean) = struct.unpack_from("<4s16If", shard)
        assert (magic, version, key, flags) == (b"FHS2", 4, role, int(role == 0))

        def blob(offset: int, length: int) -> bytes:
            return shard[strings_offset + offset:strings_offset + offset + length]

        def taxonomy(offset: int, size: int) -> list[tuple[int, bytes]]:
            return [(id, blob(start, length)) for id, start, length, _, _ in
                    TAXON.iter_unpack(shard[offset:offset + size * TAXON.size])]

        if flags:
            categories = taxonomy(category_offset, category_count)
            tags = taxonomy(tag_offset, tag_count)
            for row in DOCUMENT.iter_unpack(shard[doc_offset:doc_offset + document_count * DOCUMENT.size]):
                (id, category, count, first_ref, views, comments, length, published, title_start, title_size, _,
                 summary_start, summary_size, _, _, revision, revision_no, publication, publication_no) = row
                document_tags = tuple(tags[struct.unpack_from("<H", shard, refs_offset + 2 * offset)[0]]
                                      for offset in range(first_ref, first_ref + count))
                documents[id] = Document(id, views, comments, max(length, 1), published,
                                         categories[category] if category < len(categories) else (0, b""),
                                         blob(title_start, title_size), blob(summary_start, summary_size), document_tags,
                                         (revision, revision_no, publication, publication_no))
        terms = {}
        for hash, idf, start, length, has_positions, _ in TERM.iter_unpack(
                shard[term_offset:term_offset + term_count * TERM.size]):
            at = posting_offset + start
            terms[hash] = Term(idf, bool(has_positions), read_postings(shard, at, at + length))
        shards.append(Shard(mean, terms))
    return documents, shards


def phrase_bonus(terms: list[Term | None], article: int) -> float:
    if len(terms) < 2 or any(term is None or not term.positional or article not in term.postings for term in terms):
        return 0.0
    positions = [term.postings[article].positions for term in terms]
    for start, width, field in positions[0]:
        end = start + width
        for posting in positions[1:]:
            match = next((width for start, width, key in posting if start == end and key == field), None)
            if match is None:
                break
            end += match
        else:
            return 1.25
    return 0.0


def scores(documents: dict[int, Document], shards: list[Shard], query: str, now: int) -> dict[int, tuple[float, float]]:
    hashes = query_hashes(query)
    covered = {}
    relevance = {}
    for shard in shards:
        for hash in hashes:
            term = shard.terms.get(hash)
            if term is None:
                continue
            for id, posting in term.postings.items():
                if id not in documents:
                    continue
                title, meta, body = (TF_VALUES[min(code, 17)] for code in posting.frequency)
                positional = 2.5 * title + body
                if term.positional and posting.positions:
                    prior = covered.setdefault(id, set())
                    hits = {(field, point) for at, width, field in posting.positions for point in range(at, at + width)}
                    positional = min(positional, len(hits - prior) * (2.5 if title else 1.0))
                    prior.update(hits)
                tf = 0.9 * meta + positional
                if tf > 0:
                    norm = tf + 1.2 * (0.25 + 0.75 * (documents[id].length / max(1.0, shard.mean_length)))
                    relevance[id] = relevance.get(id, 0.0) + term.idf * ((tf * 2.2) / norm)

    result = {}
    for id, bm25 in relevance.items():
        doc = documents[id]
        hot = (12.0 * doc.comments + 0.15 * doc.views) * math.exp(-AGE_SCALE * max(0, now - doc.published_ms))
        score = bm25 + 0.35 * hot
        for shard in shards:
            score += phrase_bonus([shard.terms.get(hash) for hash in hashes], id)
        result[id] = (score, hot)
    return result


def ranked_page(documents: dict[int, Document], scored: dict[int, tuple[float, float]],
                sort: int, page: int, size: int) -> tuple[list[int], int]:
    assert page >= 0 and size >= 0, "Fixture inputs must use the intended nonnegative Wasm ABI"

    def key(id: int):
        final, hot = scored[id]
        date = documents[id].published_ms
        if sort == 1:
            return -date, -final, id
        if sort == 2:
            return -hot, -final, id
        return -final, -hot, -date, id

    size = max(size, 1)
    start = (max(page, 1) - 1) * size
    return sorted(scored, key=key)[start:start + size], len(scored)


def result_bytes(items: list[Document], total: int) -> bytes:
    rows, tags, blob = bytearray(), bytearray(), bytearray()

    def append_blob(text: bytes) -> bytes:
        ref = struct.pack("<II", len(blob), len(text))
        blob.extend(text)
        return ref

    for item in items:
        rows.extend(struct.pack("<IIqI", item.id, item.views, item.published_ms, item.category[0]))
        for text in (item.category[1], item.title, item.summary):
            rows.extend(append_blob(text))
        rows.extend(struct.pack("<IIqIqI", len(tags) // 12, len(item.tags), *item.coordinates))
        for id, name in item.tags:
            tags.extend(U32.pack(id) + append_blob(name))
    tag_offset = RESULT.size + len(rows)
    return RESULT.pack(b"FSR4", 4, total, len(items), tag_offset, tag_offset + len(tags)) + rows + tags + blob


class FixedV1SearchRankingTests(unittest.TestCase):
    def test_source_fixture_raw_pages_and_scores(self):
        case_file = json.loads((FIXTURES / "v1-search-ranking.json").read_text())
        package = read_hex("v1-search-ranking-fspk")
        self.assertEqual(sha256(package).hexdigest(), case_file["packageSha256"])
        documents, shards = load_full_package(package)
        for case in case_file["cases"]:
            with self.subTest(case=case["name"]):
                scored = scores(documents, shards, case["query"], case_file["nowMs"])
                ids, total = ranked_page(documents, scored, case["sort"], case["page"], case["size"])
                self.assertEqual(ids, case["ids"])
                self.assertEqual(total, case["total"])
                for id, values in case.get("scores", {}).items():
                    self.assertAlmostEqual(scored[int(id)][0], values[0], places=10)
                    self.assertAlmostEqual(scored[int(id)][1], values[1], places=10)
                raw = result_bytes([documents[id] for id in ids], total)
                self.assertEqual(struct.unpack_from("<4sIII", raw), (b"FSR4", 4, total, len(ids)))
                if not ids:
                    self.assertEqual(raw, RESULT.pack(b"FSR4", 4, total, 0, 24, 24))
                self.assertEqual([U32.unpack_from(raw, 24 + n * 76)[0] for n in range(len(ids))], ids)
                for index, id in enumerate(ids):
                    self.assertEqual(struct.unpack_from("<qIqI", raw, 24 + index * 76 + 52),
                                     (9_007_199_254_740_990 + id, 2, 9_007_199_254_741_990 + id, 3))

    def test_matches_existing_shared_raw_fsr4_bytes(self):
        documents, shards = load_full_package(read_hex("search-fspk-v4"))
        scored = scores(documents, shards, "needle", 1_700_000_003_000)
        ids, total = ranked_page(documents, scored, 0, 1, 10)
        self.assertEqual(ids, [42])
        self.assertEqual(result_bytes([documents[id] for id in ids], total), read_hex("search-fsr4"))

    def test_legacy_query_hashes_do_not_normalize_or_keep_repeat_order(self):
        self.assertEqual(query_hashes("foo_bar + FOO 雪"), [0x3FF6E96A, 0x450E998D, 0xF6A5C420])
        self.assertEqual(query_hashes("foo bar foo"), query_hashes("bar foo"))
        self.assertEqual(query_hashes("ＦＯＯ 𠀀 ﬁ"), [])

    def test_sort_specific_tie_breaks_and_future_heat(self):
        documents, shards = load_full_package(read_hex("v1-search-ranking-fspk"))
        # Relevance compares heat before publication. Hot resolves remaining ties directly by ID.
        self.assertEqual(ranked_page(documents, {10: (3., 2.), 20: (3., 1.)}, 0, 1, 2)[0], [10, 20])
        self.assertEqual(ranked_page(documents, {10: (3., 2.), 20: (3., 2.)}, 2, 1, 2)[0], [10, 20])
        self.assertEqual(ranked_page(documents, {10: (3., 2.), 40: (4., 1.)}, 1, 1, 2)[0], [40, 10])
        before_publication = scores(documents, shards, "alpha", documents[20].published_ms - 1)
        self.assertAlmostEqual(before_publication[20][1], 0.3, places=12)

    def test_legacy_service_can_reverse_equal_ids_within_only_the_selected_page(self):
        documents, shards = load_full_package(read_hex("v1-search-ranking-fspk"))
        scored = scores(documents, shards, "alpha", 1_700_000_000_000)
        raw, total = ranked_page(documents, scored, 0, 1, 2)
        self.assertEqual(raw, [10, 40])
        self.assertEqual(total, 5)
        self.assertEqual(scored[10], scored[40])
        left, right = (documents[id] for id in raw)
        # The old TypeScript page scorer sees identical display/search input and no body.
        for field in ("title", "summary", "category", "tags", "views", "published_ms"):
            self.assertEqual(getattr(left, field), getattr(right, field))
        # Its last distinguishable comparator is descending ID, applied to these two rows only.
        self.assertEqual(sorted(raw, reverse=True), [40, 10])


def read_hex(name: str) -> bytes:
    return bytes.fromhex((FIXTURES / f"{name}.hex").read_text())


if __name__ == "__main__":
    unittest.main()
