#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest


TOOL = pathlib.Path(__file__).resolve().parents[2] / "tools/fspt-patch.py"
spec = importlib.util.spec_from_file_location("fspt_patch", TOOL)
fspt = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fspt
spec.loader.exec_module(fspt)

TICKS = 638879616000000007
GENERATION = "3a56b79c124de80f"
BASE_PREFIX = "c28756e349a01fbd"
RELEASE_ROOT = "/release-derived/20260711000004-abcdef123456/search"
CORE_SHA = "013579bdf2468ace" * 4
RECENT_SHA = "3141592653589793" * 4
ARCHIVE_SHA = "abcdef0123456789" * 4
PATCH_SHA = "fedcba9876543210" * 4
ROLE_GROUPS = (("core", "recent"), ("archive",), ())


def wire_string(value):
    payload = value.encode("utf-8") if isinstance(value, str) else value
    return struct.pack("<i", len(payload)) + payload


def nullable(value):
    return b"\0" if value is None else b"\x01" + wire_string(value)


def shard_row(role, full_url, full_sha256, patch_url=None, patch_sha256=None, phase=0):
    return (
        struct.pack("<I", role) + wire_string(full_url) + wire_string(full_sha256)
        + nullable(patch_url) + nullable(patch_sha256) + struct.pack("<i", phase)
    )


def full_url(role, root="/search"):
    return f"{root}/index.{role}.{GENERATION}.bin"


def patch_url(role, root="/search"):
    return f"{root}/patches/index.{role}.{BASE_PREFIX}-{GENERATION}.patch"


def normal_rows(root="/search"):
    return (
        shard_row(0, full_url("core", root), CORE_SHA, patch_url("core", root), PATCH_SHA),
        shard_row(1, full_url("recent", root), RECENT_SHA),
        shard_row(2, full_url("archive", root), ARCHIVE_SHA, phase=1),
    )


def manifest_vector(*, generation=GENERATION, ticks=TICKS, rows=None, groups=ROLE_GROUPS, wire=1, schema=4):
    if rows is None:
        rows = normal_rows()
    return (
        struct.pack("<4sIiq", b"FSIM", wire, schema, ticks)
        + wire_string(generation) + struct.pack("<i", len(rows)) + b"".join(rows)
        + b"".join(struct.pack("<i", len(group)) + b"".join(map(wire_string, group)) for group in groups)
    )


def change_word(data, offset, value):
    return data[:offset] + struct.pack("<i", value) + data[offset + 4:]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def membership_shard(role, documents=(), terms=()):
    postings = bytearray()
    term_rows = bytearray()
    for term, ids in terms:
        encoded = bytes([len(ids)]) + b"".join(
            bytes((article - previous, 0, 0, 1, 0))
            for previous, article in zip((0, *ids), ids)
        )
        term_rows.extend(struct.pack("<IfIIII", term, 1.0, len(postings), len(encoded), 0, 0))
        postings.extend(encoded)
    doc_rows = b"".join(struct.pack("<I16xI52x", article, 1) for article in documents)
    docs_at = 72 + len(term_rows)
    sections_at = (docs_at + len(doc_rows) + 7) & ~7
    header = struct.pack(
        "<4s16If", b"FHS2", 4, role, int(role == 0), len(terms), len(documents),
        0, 0, 0, 72, docs_at, sections_at, sections_at, sections_at, sections_at,
        sections_at, len(postings), 1.0,
    )
    return header + term_rows + doc_rows + bytes(sections_at - docs_at - len(doc_rows)) + postings


def write_catalog(directory, shards, *, patch=None, base_prefix=None, generation=None):
    directory.mkdir(exist_ok=True)
    generation = generation or digest(b"".join(shards))[:16]
    rows = []
    for role, (name, data) in enumerate(zip(("core", "recent", "archive"), shards)):
        filename = f"index.{name}.{generation}.bin"
        (directory / filename).write_bytes(data)
        patch_name = None
        patch_hash = None
        if role == 1 and patch is not None:
            patch_name = f"patches/index.recent.{base_prefix}-{generation}.patch"
            (directory / "patches").mkdir(exist_ok=True)
            (directory / patch_name).write_bytes(patch)
            patch_hash = digest(patch)
        rows.append(shard_row(
            role, f"/search/{filename}", digest(data),
            f"/search/{patch_name}" if patch_name else None, patch_hash, int(role == 2),
        ))
    manifest = directory / "index.manifest.aeds"
    manifest.write_bytes(manifest_vector(generation=generation, rows=rows))
    return manifest


def catalog_cli(target, previous, *options):
    return subprocess.run([
        sys.executable, "-B", str(TOOL), "catalog", str(target), "--assets", str(target.parent),
        "--previous", str(previous), "--previous-assets", str(previous.parent), "--role", "recent",
        "--manifest-sha256", digest(target.read_bytes()),
        "--previous-manifest-sha256", digest(previous.read_bytes()),
        *map(str, options),
    ], capture_output=True, text=True)


class FsimCatalogTests(unittest.TestCase):
    def test_reads_exact_ticks_role_schedule_and_optional_patch(self):
        for root in ("/search", RELEASE_ROOT):
            with self.subTest(root=root):
                data = manifest_vector(rows=normal_rows(root))
                result = fspt.decode_manifest(data)
                self.assertEqual(result.generation, GENERATION)
                self.assertEqual(result.generated_ticks, TICKS)
                self.assertEqual(set(result.shards), {0, 1, 2})
                self.assertEqual((result.initial_roles, result.background_roles, result.deep_roles), ROLE_GROUPS)
                self.assertEqual(
                    [(shard.full_url, shard.full_sha256, shard.patch_url, shard.patch_sha256, shard.load_phase)
                     for shard in (result.shards[0], result.shards[1], result.shards[2])],
                    [
                        (full_url("core", root), CORE_SHA, patch_url("core", root), PATCH_SHA, 0),
                        (full_url("recent", root), RECENT_SHA, None, None, 0),
                        (full_url("archive", root), ARCHIVE_SHA, None, None, 1),
                    ],
                )

    def test_initial_catalog_can_omit_every_patch(self):
        _, recent, archive = normal_rows()
        core = shard_row(0, full_url("core"), CORE_SHA)
        result = fspt.decode_manifest(manifest_vector(rows=(core, recent, archive)))
        for shard in result.shards.values():
            self.assertIsNone(shard.patch_url)
            self.assertIsNone(shard.patch_sha256)

    def test_rejects_bad_versions_ticks_and_framing(self):
        valid = manifest_vector()
        cases = {
            "wrong magic": b"FSPT" + valid[4:],
            "wrong wire version": manifest_vector(wire=2),
            "wrong schema version": manifest_vector(schema=3),
            "negative ticks": manifest_vector(ticks=-1),
            "ticks beyond DateTime": manifest_vector(ticks=3_155_378_976_000_000_000),
            "truncated header": valid[:19],
            "negative string length": change_word(valid, 20, -1),
            "oversized string length": change_word(valid, 20, 4097),
            "negative shard count": change_word(valid, 40, -1),
            "oversized shard count": change_word(valid, 40, 33),
            "bad nullable marker": valid.replace(nullable(patch_url("core")), b"\x02" + wire_string(patch_url("core")), 1),
            "negative role group count": change_word(valid, len(valid) - 4, -1),
            "oversized role group count": change_word(valid, len(valid) - 4, 33),
            "truncated role groups": valid[:-1],
            "trailing byte": valid + b"\0",
        }
        for name, data in cases.items():
            with self.subTest(name=name), self.assertRaises(fspt.PatchError):
                fspt.decode_manifest(data)

    def test_rejects_wrong_role_assignments_and_utf8(self):
        core, recent, archive = normal_rows()
        cases = {
            "missing role": manifest_vector(rows=(core, recent)),
            "duplicate role": manifest_vector(rows=(core, recent, recent)),
            "unknown role": manifest_vector(rows=(core, recent, change_word(archive, 0, 3))),
            "wrong archive phase": manifest_vector(rows=(core, recent, change_word(archive, len(archive) - 4, 0))),
            "role in two groups": manifest_vector(groups=(("core", "recent"), ("archive", "core"), ())),
            "wrong role group": manifest_vector(groups=(("core", "archive"), ("recent",), ())),
            "unexpected deep role": manifest_vector(groups=(("core", "recent"), ("archive",), ("archive",))),
            "invalid generation UTF-8": manifest_vector(generation=b"\xff" * 16),
            "invalid path UTF-8": manifest_vector(rows=(shard_row(0, b"/search/\xc0\xaf", CORE_SHA), recent, archive)),
            "invalid role UTF-8": manifest_vector(groups=(("core", b"\xed\xa0\x80"), ("archive",), ())),
        }
        for name, data in cases.items():
            with self.subTest(name=name), self.assertRaises(fspt.PatchError):
                fspt.decode_manifest(data)

    def test_rejects_noncanonical_urls_and_inconsistent_hashes(self):
        _, recent, archive = normal_rows()
        url = full_url("core")
        delta = patch_url("core")
        cases = {
            "absolute URL": shard_row(0, "https://example.invalid" + url, CORE_SHA),
            "network path": shard_row(0, "//example.invalid" + url, CORE_SHA),
            "escaping search path": shard_row(0, "/search/../" + url.rsplit("/", 1)[1], CORE_SHA),
            "encoded slash": shard_row(0, url.replace("/search/", "/search%2F"), CORE_SHA),
            "URL query": shard_row(0, url + "?cache=1", CORE_SHA),
            "wrong full role": shard_row(0, full_url("recent"), CORE_SHA),
            "wrong full generation": shard_row(0, url.replace(GENERATION, "0" * 16), CORE_SHA),
            "short full digest": shard_row(0, url, CORE_SHA[:-1]),
            "nonhex full digest": shard_row(0, url, "z" + CORE_SHA[1:]),
            "uppercase full digest": shard_row(0, url, CORE_SHA.upper()),
            "patch URL without digest": shard_row(0, url, CORE_SHA, delta),
            "patch digest without URL": shard_row(0, url, CORE_SHA, patch_sha256=PATCH_SHA),
            "nonhex patch digest": shard_row(0, url, CORE_SHA, delta, "z" + PATCH_SHA[1:]),
            "wrong patch role": shard_row(0, url, CORE_SHA, patch_url("archive"), PATCH_SHA),
            "wrong patch generation": shard_row(0, url, CORE_SHA, delta.replace(GENERATION, "0" * 16), PATCH_SHA),
            "short patch base prefix": shard_row(0, url, CORE_SHA, delta.replace(BASE_PREFIX, "0" * 15), PATCH_SHA),
            "patch wrong root": shard_row(0, url, CORE_SHA, patch_url("core", RELEASE_ROOT), PATCH_SHA),
            "mixed catalog roots": shard_row(0, full_url("core", RELEASE_ROOT), CORE_SHA),
        }
        for name, core in cases.items():
            with self.subTest(name=name), self.assertRaises(fspt.PatchError):
                fspt.decode_manifest(manifest_vector(rows=(core, recent, archive)))

    def test_rejects_impossible_release_timestamp(self):
        root = "/release-derived/20260230000000-abcdef123456/search"
        with self.assertRaises(fspt.PatchError):
            fspt.decode_manifest(manifest_vector(rows=normal_rows(root)))


class CatalogCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = pathlib.Path(temporary.name)
        documents = tuple(range(1, 21))
        core, archive = membership_shard(0), membership_shard(2)
        base = membership_shard(1, documents, ((1, documents),))
        target = membership_shard(1, documents, ((1, tuple(id for id in documents if id != 7)), (2, (7,))))
        self.target_shards = (core, target, archive)
        self.mini_shard = membership_shard(1, (7,), ((2, (7,)),))
        self.patch = struct.pack("<4s5I", b"FSPT", 3, 1, 1, len(self.mini_shard), 0) + b"\x07" + self.mini_shard
        self.base_prefix = digest(base)[:16]
        self.generation = digest(b"".join(self.target_shards))[:16]
        self.previous = write_catalog(self.folder / "previous", (core, base, archive))
        self.target = write_catalog(
            self.folder / "current", self.target_shards, patch=self.patch, base_prefix=self.base_prefix,
        )

    def test_verifies_published_bytes_and_reproduces_only_into_a_new_file(self):
        verified = catalog_cli(self.target, self.previous)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        report = json.loads(verified.stdout)
        self.assertEqual(report["generation"], self.generation)
        self.assertEqual(report["role"], "recent")
        self.assertEqual(report["verifiedFullShards"], 3)
        self.assertEqual(report["patchSha256"], digest(self.patch))
        self.assertEqual(report["tombstones"], [7])
        self.assertTrue(report["targetMembershipMatches"])
        self.assertFalse(report["rankingChecked"])

        published = self.target.parent / "patches" / f"index.recent.{self.base_prefix}-{self.generation}.patch"
        published.unlink()
        mini = self.folder / "mini.bin"
        output = self.folder / "reproduced.patch"
        mini.write_bytes(self.mini_shard)
        options = ("--emit", output, "--tombstone", 7, "--mini-shard", mini)
        emitted = catalog_cli(self.target, self.previous, *options)
        self.assertEqual(emitted.returncode, 0, emitted.stderr)
        self.assertEqual(output.read_bytes(), self.patch)
        output.write_bytes(b"existing output")
        refused = catalog_cli(self.target, self.previous, *options)
        self.assertEqual(refused.returncode, 1, refused.stderr)
        self.assertEqual(output.read_bytes(), b"existing output")

    def test_rejects_a_changed_full_shard_outside_the_selected_role(self):
        changed_archive = membership_shard(2, (21,))
        archive_path = self.target.parent / f"index.archive.{self.generation}.bin"
        archive_path.write_bytes(changed_archive)
        wrong_digest = catalog_cli(self.target, self.previous)
        self.assertEqual(wrong_digest.returncode, 1)
        self.assertIn("SHA-256", wrong_digest.stderr)

        write_catalog(
            self.target.parent, (*self.target_shards[:2], changed_archive), patch=self.patch,
            base_prefix=self.base_prefix, generation=self.generation,
        )
        wrong_generation = catalog_cli(self.target, self.previous)
        self.assertEqual(wrong_generation.returncode, 1)
        self.assertIn("generation", wrong_generation.stderr)

    def test_rejects_a_patch_for_a_different_base_digest_prefix(self):
        write_catalog(self.target.parent, self.target_shards, patch=self.patch, base_prefix="0" * 16)
        result = catalog_cli(self.target, self.previous)
        self.assertEqual(result.returncode, 1)
        self.assertIn("base digest prefix", result.stderr)

    def test_cannot_emit_a_pinned_patch_with_the_wrong_target_membership(self):
        wrong_mini = membership_shard(1, (7,), ((3, (7,)),))
        wrong_patch = struct.pack("<4s5I", b"FSPT", 3, 1, 1, len(wrong_mini), 0) + b"\x07" + wrong_mini
        write_catalog(self.target.parent, self.target_shards, patch=wrong_patch, base_prefix=self.base_prefix)
        mini = self.folder / "wrong.bin"
        mini.write_bytes(wrong_mini)
        output = self.folder / "refused.patch"
        result = catalog_cli(self.target, self.previous, "--emit", output, "--tombstone", 7, "--mini-shard", mini)
        self.assertEqual(result.returncode, 1)
        self.assertIn("membership", result.stderr)
        self.assertFalse(output.exists())

    def test_rejects_a_declared_patch_over_the_fixed_tombstone_threshold(self):
        # Four tombstones exceed the 15% limit of the twenty-document target.
        large_patch = struct.pack("<4s5I", b"FSPT", 3, 4, 4, 0, 0) + b"\x01\x01\x01\x01"
        write_catalog(self.target.parent, self.target_shards, patch=large_patch, base_prefix=self.base_prefix)
        result = catalog_cli(self.target, self.previous)
        self.assertEqual(result.returncode, 1)
        self.assertIn("emission thresholds", result.stderr)


if __name__ == "__main__":
    unittest.main()
