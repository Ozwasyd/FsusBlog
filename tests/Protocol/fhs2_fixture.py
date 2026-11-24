"""Independent FHS2 v4 / FSPT v3 helpers used by patch and catalog tests."""

import hashlib
import json
import pathlib
import struct
import subprocess
import sys

from tool_module_fixture import load_tool_module

FSPT_TOOL = pathlib.Path(__file__).resolve().parents[2] / "tools/fspt-patch.py"
fspt = load_tool_module("fspt_patch", FSPT_TOOL)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def patch_word(data, offset, value, fmt="<i"):
    return data[:offset] + struct.pack(fmt, value) + data[offset + 4 :]


def patch_vector(tombstone_bytes, count, appended=b""):
    return (
        struct.pack("<4s5I", b"FSPT", 3, count, len(tombstone_bytes), len(appended), 0)
        + tombstone_bytes
        + appended
    )


def run_fspt_cli(*arguments):
    return subprocess.run(
        [sys.executable, "-B", str(FSPT_TOOL), *map(str, arguments)],
        capture_output=True,
        text=True,
    )


def assert_patch_rejected(test_case, cases, check):
    for name, value in cases.items():
        with test_case.subTest(name=name), test_case.assertRaises(fspt.PatchError):
            check(value)


def assert_cli_report(test_case, result, expected):
    test_case.assertEqual(result.returncode, 0, result.stderr)
    report = json.loads(result.stdout)
    for key, value in expected.items():
        test_case.assertEqual(report[key], value)


def posting_vector(article_ids):
    return bytes([len(article_ids)]) + b"".join(
        bytes((article_id - previous, 0, 0, 1, 0))
        for previous, article_id in zip((0, *article_ids), article_ids)
    )


def encode_terms(terms):
    term_table, posting_data = bytearray(), bytearray()
    for term_hash, postings, positions in terms:
        term_table.extend(struct.pack("<IfIIII", term_hash, 1.0, len(posting_data), len(postings), positions, 0))
        posting_data.extend(postings)
    return term_table, posting_data


def assemble_shard(role, flags, term_count, document_count, term_table, rows, posting_data):
    terms_at = 72
    documents_at = terms_at + len(term_table)
    document_end = documents_at + len(rows)
    empty_at = (document_end + 7) & ~7
    header = struct.pack(
        "<4s16If", b"FHS2", 4, role, flags, term_count, document_count, 0, 0, 0,
        terms_at, documents_at, empty_at, empty_at, empty_at, empty_at, empty_at, len(posting_data), 1.0,
    )
    return header + term_table + rows + bytes(empty_at - document_end) + posting_data


def shard_vector(documents=(), terms=(), role=1):
    term_table, posting_data = encode_terms(terms)
    rows = b"".join(struct.pack("<I16xI52x", article, 1) for article in documents)
    return assemble_shard(role, int(role == 0), len(terms), len(documents), term_table, rows, posting_data)


def membership_shard(role, documents=(), terms=()):
    return shard_vector(documents, tuple((term, posting_vector(ids), 0) for term, ids in terms), role=role)
