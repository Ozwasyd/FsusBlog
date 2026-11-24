#!/usr/bin/env python3
import pathlib
import struct
import tempfile
import unittest

import fhs2_fixture as fixture
from fhs2_fixture import digest, fspt, membership_shard, patch_vector, patch_word

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
    rows = normal_rows() if rows is None else rows
    return (
        struct.pack("<4sIiq", b"FSIM", wire, schema, ticks)
        + wire_string(generation) + struct.pack("<i", len(rows)) + b"".join(rows)
        + b"".join(struct.pack("<i", len(group)) + b"".join(map(wire_string, group)) for group in groups)
    )


def write_catalog(directory, shards, *, patch=None, base_prefix=None, generation=None):
    directory.mkdir(exist_ok=True)
    generation = generation or digest(b"".join(shards))[:16]
    rows = []
    for role, (name, data) in enumerate(zip(("core", "recent", "archive"), shards)):
        filename = f"index.{name}.{generation}.bin"
        (directory / filename).write_bytes(data)
        patch_name = patch_hash = None
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
    return fixture.run_fspt_cli(
        "catalog", target, "--assets", target.parent,
        "--previous", previous, "--previous-assets", previous.parent, "--role", "recent",
        "--manifest-sha256", digest(target.read_bytes()),
        "--previous-manifest-sha256", digest(previous.read_bytes()),
        *options,
    )


class FsimCatalogTests(unittest.TestCase):
    def test_reads_exact_ticks_role_schedule_and_optional_patch(self):
        for root in ("/search", RELEASE_ROOT):
            with self.subTest(root=root):
                result = fspt.decode_manifest(manifest_vector(rows=normal_rows(root)))
                self.assertEqual((result.generation, result.generated_ticks, set(result.shards)), (GENERATION, TICKS, {0, 1, 2}))
                self.assertEqual((result.initial_roles, result.background_roles, result.deep_roles), ROLE_GROUPS)
                self.assertEqual(
                    [(s.full_url, s.full_sha256, s.patch_url, s.patch_sha256, s.load_phase)
                     for s in (result.shards[0], result.shards[1], result.shards[2])],
                    [
                        (full_url("core", root), CORE_SHA, patch_url("core", root), PATCH_SHA, 0),
                        (full_url("recent", root), RECENT_SHA, None, None, 0),
                        (full_url("archive", root), ARCHIVE_SHA, None, None, 1),
                    ],
                )

    def test_initial_catalog_can_omit_every_patch(self):
        _, recent, archive = normal_rows()
        result = fspt.decode_manifest(manifest_vector(rows=(shard_row(0, full_url("core"), CORE_SHA), recent, archive)))
        for shard in result.shards.values():
            self.assertEqual((shard.patch_url, shard.patch_sha256), (None, None))

    def test_rejects_bad_versions_ticks_and_framing(self):
        valid = manifest_vector()
        cases = {
            "wrong magic": b"FSPT" + valid[4:],
            "wrong wire version": manifest_vector(wire=2),
            "wrong schema version": manifest_vector(schema=3),
            "negative ticks": manifest_vector(ticks=-1),
            "ticks beyond DateTime": manifest_vector(ticks=3_155_378_976_000_000_000),
            "truncated header": valid[:19],
            "negative string length": patch_word(valid, 20, -1),
            "oversized string length": patch_word(valid, 20, 4097),
            "negative shard count": patch_word(valid, 40, -1),
            "oversized shard count": patch_word(valid, 40, 33),
            "bad nullable marker": valid.replace(nullable(patch_url("core")), b"\x02" + wire_string(patch_url("core")), 1),
            "negative role group count": patch_word(valid, len(valid) - 4, -1),
            "oversized role group count": patch_word(valid, len(valid) - 4, 33),
            "truncated role groups": valid[:-1],
            "trailing byte": valid + b"\0",
        }
        fixture.assert_patch_rejected(self, cases, fspt.decode_manifest)

    def test_rejects_wrong_role_assignments_and_utf8(self):
        core, recent, archive = normal_rows()
        cases = {
            "missing role": manifest_vector(rows=(core, recent)),
            "duplicate role": manifest_vector(rows=(core, recent, recent)),
            "unknown role": manifest_vector(rows=(core, recent, patch_word(archive, 0, 3))),
            "wrong archive phase": manifest_vector(rows=(core, recent, patch_word(archive, len(archive) - 4, 0))),
            "role in two groups": manifest_vector(groups=(("core", "recent"), ("archive", "core"), ())),
            "wrong role group": manifest_vector(groups=(("core", "archive"), ("recent",), ())),
            "unexpected deep role": manifest_vector(groups=(("core", "recent"), ("archive",), ("archive",))),
            "invalid generation UTF-8": manifest_vector(generation=b"\xff" * 16),
            "invalid path UTF-8": manifest_vector(rows=(shard_row(0, b"/search/\xc0\xaf", CORE_SHA), recent, archive)),
            "invalid role UTF-8": manifest_vector(groups=(("core", b"\xed\xa0\x80"), ("archive",), ())),
        }
        fixture.assert_patch_rejected(self, cases, fspt.decode_manifest)

    def test_rejects_noncanonical_urls_and_inconsistent_hashes(self):
        _, recent, archive = normal_rows()
        url, delta = full_url("core"), patch_url("core")
        row = lambda u=url, sha=CORE_SHA, pu=None, ps=None: shard_row(0, u, sha, pu, ps)
        cases = {
            "absolute URL": row("https://example.invalid" + url),
            "network path": row("//example.invalid" + url),
            "escaping search path": row("/search/../" + url.rsplit("/", 1)[1]),
            "encoded slash": row(url.replace("/search/", "/search%2F")),
            "URL query": row(url + "?cache=1"),
            "wrong full role": row(full_url("recent")),
            "wrong full generation": row(url.replace(GENERATION, "0" * 16)),
            "short full digest": row(sha=CORE_SHA[:-1]),
            "nonhex full digest": row(sha="z" + CORE_SHA[1:]),
            "uppercase full digest": row(sha=CORE_SHA.upper()),
            "patch URL without digest": row(pu=delta),
            "patch digest without URL": row(ps=PATCH_SHA),
            "nonhex patch digest": row(pu=delta, ps="z" + PATCH_SHA[1:]),
            "wrong patch role": row(pu=patch_url("archive"), ps=PATCH_SHA),
            "wrong patch generation": row(pu=delta.replace(GENERATION, "0" * 16), ps=PATCH_SHA),
            "short patch base prefix": row(pu=delta.replace(BASE_PREFIX, "0" * 15), ps=PATCH_SHA),
            "patch wrong root": row(pu=patch_url("core", RELEASE_ROOT), ps=PATCH_SHA),
            "mixed catalog roots": row(full_url("core", RELEASE_ROOT)),
        }
        fixture.assert_patch_rejected(self, cases, lambda core: fspt.decode_manifest(manifest_vector(rows=(core, recent, archive))))

    def test_rejects_impossible_release_timestamp(self):
        with self.assertRaises(fspt.PatchError):
            fspt.decode_manifest(manifest_vector(rows=normal_rows("/release-derived/20260230000000-abcdef123456/search")))


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
        self.patch = patch_vector(b"\x07", 1, self.mini_shard)
        self.base_prefix = digest(base)[:16]
        self.generation = digest(b"".join(self.target_shards))[:16]
        self.previous = write_catalog(self.folder / "previous", (core, base, archive))
        self.target = write_catalog(
            self.folder / "current", self.target_shards, patch=self.patch, base_prefix=self.base_prefix,
        )

    def assert_cli_error(self, message, *options):
        result = catalog_cli(self.target, self.previous, *options)
        self.assertEqual(result.returncode, 1)
        self.assertIn(message, result.stderr)

    def test_verifies_published_bytes_and_reproduces_only_into_a_new_file(self):
        fixture.assert_cli_report(self, catalog_cli(self.target, self.previous), {
            "generation": self.generation,
            "role": "recent",
            "verifiedFullShards": 3,
            "patchSha256": digest(self.patch),
            "tombstones": [7],
            "targetMembershipMatches": True,
            "rankingChecked": False,
        })

        (self.target.parent / "patches" / f"index.recent.{self.base_prefix}-{self.generation}.patch").unlink()
        mini, output = self.folder / "mini.bin", self.folder / "reproduced.patch"
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
        (self.target.parent / f"index.archive.{self.generation}.bin").write_bytes(changed_archive)
        self.assert_cli_error("SHA-256")

        write_catalog(
            self.target.parent, (*self.target_shards[:2], changed_archive), patch=self.patch,
            base_prefix=self.base_prefix, generation=self.generation,
        )
        self.assert_cli_error("generation")

    def test_rejects_a_patch_for_a_different_base_digest_prefix(self):
        write_catalog(self.target.parent, self.target_shards, patch=self.patch, base_prefix="0" * 16)
        self.assert_cli_error("base digest prefix")

    def test_cannot_emit_a_pinned_patch_with_the_wrong_target_membership(self):
        wrong_mini = membership_shard(1, (7,), ((3, (7,)),))
        write_catalog(self.target.parent, self.target_shards, patch=patch_vector(b"\x07", 1, wrong_mini), base_prefix=self.base_prefix)
        mini, output = self.folder / "wrong.bin", self.folder / "refused.patch"
        mini.write_bytes(wrong_mini)
        self.assert_cli_error("membership", "--emit", output, "--tombstone", 7, "--mini-shard", mini)
        self.assertFalse(output.exists())

    def test_rejects_a_declared_patch_over_the_fixed_tombstone_threshold(self):
        # Four tombstones exceed the 15% limit of the twenty-document target.
        write_catalog(self.target.parent, self.target_shards, patch=patch_vector(b"\x01\x01\x01\x01", 4), base_prefix=self.base_prefix)
        self.assert_cli_error("emission thresholds")


if __name__ == "__main__":
    unittest.main()
