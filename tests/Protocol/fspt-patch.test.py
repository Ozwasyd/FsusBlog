#!/usr/bin/env python3
import json
import pathlib
import tempfile
import unittest

import fhs2_fixture as fixture
from fhs2_fixture import digest, fspt, membership_shard, patch_vector, posting_vector, shard_vector

RECENT = 1
ARCHIVE = 2
FIRST_TERM = 0x12345678
SECOND_TERM = 0x87654321
DELETED_TERM = 0xF1234567

# FSPT v3 header, then independent unsigned base-128 deltas 1, 128, 271.
TOMBSTONE_ONLY = bytes.fromhex("""
    46535054 03000000 03000000 05000000 00000000 00000000
    01 8001 8f02
""")


def changed_u32(data, offset, value):
    return fixture.patch_word(data, offset, value, "<I")


class FsptPatchTests(unittest.TestCase):
    def test_fixed_tombstone_only_patch(self):
        patch = fspt.decode_patch(TOMBSTONE_ONLY)
        self.assertEqual((patch.tombstones, patch.appended), ((1, 129, 400), None))

    def test_appended_positional_shard(self):
        # Article 3 has body TF 1 and one range from position zero of length
        # two in the Body field (4).
        postings = bytes.fromhex("01 03 00 00 01 01 00 02 04")
        patch = fspt.decode_patch(patch_vector(b"\x03", 1, shard_vector((3,), ((FIRST_TERM, postings, 1),))))
        self.assertEqual(
            (patch.tombstones, patch.appended.role, patch.appended.documents, patch.appended.postings),
            ((3,), RECENT, (3,), {FIRST_TERM: (3,)}),
        )

    def test_overlay_replaces_same_id_and_removes_deleted_postings(self):
        base = fspt.decode_shard(membership_shard(
            RECENT, (1, 3, 4), ((FIRST_TERM, (1, 3)), (SECOND_TERM, (1,)), (DELETED_TERM, (4,))),
        ))
        mini = membership_shard(RECENT, (3, 9), ((SECOND_TERM, (3, 9)),))
        result = fspt.overlay(base, fspt.decode_patch(patch_vector(bytes.fromhex("03 01 05"), 3, mini)), RECENT)
        self.assertEqual(
            (result.role, result.documents, result.postings),
            (RECENT, (1, 3, 9), {FIRST_TERM: (1,), SECOND_TERM: (1, 3, 9)}),
        )
        self.assertEqual((base.documents, base.postings[FIRST_TERM]), ((1, 3, 4), (1, 3)))

    def test_tombstone_only_overlay_and_role_mismatches(self):
        base = fspt.decode_shard(membership_shard(RECENT, (1, 2), ((FIRST_TERM, (1, 2)),)))
        deletion = fspt.decode_patch(TOMBSTONE_ONLY)
        result = fspt.overlay(base, deletion, RECENT)
        self.assertEqual((result.documents, result.postings), ((2,), {FIRST_TERM: (2,)}))
        with self.assertRaises(fspt.PatchError):
            fspt.overlay(base, deletion, ARCHIVE)

        different_role = fspt.decode_patch(patch_vector(b"\x01", 1, membership_shard(ARCHIVE, (1,), ((FIRST_TERM, (1,)),))))
        with self.assertRaises(fspt.PatchError):
            fspt.overlay(base, different_role, RECENT)

    def test_rejects_invalid_patch_headers_and_lengths(self):
        cases = {
            "truncated header": TOMBSTONE_ONLY[:23],
            "wrong magic": b"FSIM" + TOMBSTONE_ONLY[4:],
            "wrong version": changed_u32(TOMBSTONE_ONLY, 4, 4),
            "reserved word": changed_u32(TOMBSTONE_ONLY, 20, 1),
            "short tombstone section": changed_u32(TOMBSTONE_ONLY, 12, 4),
            "oversized tombstone section": changed_u32(TOMBSTONE_ONLY, 12, 0xFFFFFFFF),
            "missing appended shard": changed_u32(TOMBSTONE_ONLY, 16, 1),
            "trailing byte": TOMBSTONE_ONLY + b"\0",
            "small tombstone count": changed_u32(TOMBSTONE_ONLY, 8, 2),
            "large tombstone count": changed_u32(TOMBSTONE_ONLY, 8, 4),
        }
        fixture.assert_patch_rejected(self, cases, fspt.decode_patch)

    def test_rejects_invalid_tombstone_sequences(self):
        cases = {
            "zero ID": ("00", 1),
            "duplicate ID": ("01 00", 2),
            "incomplete varint": ("80", 1),
            "overlong varint": ("81 00", 1),
            "six-byte varint": ("80 80 80 80 80 00", 1),
            "overflowing fifth byte": ("ff ff ff ff 10", 1),
            "descending wraparound": ("02 ff ff ff ff 0f", 2),
        }
        fixture.assert_patch_rejected(self, cases, lambda item: fspt.decode_patch(patch_vector(bytes.fromhex(item[0]), item[1])))

    def test_rejects_invalid_nested_shard_terms_and_postings(self):
        valid_posting = posting_vector((3,))
        valid_shard = shard_vector((3,), ((FIRST_TERM, valid_posting, 0),))
        cases = {
            "old shard version": changed_u32(valid_shard, 4, 3),
            "unknown shard role": changed_u32(valid_shard, 8, 3),
            "misaligned document offset": changed_u32(valid_shard, 40, 97),
            "term starts outside posting section": changed_u32(valid_shard, 80, len(valid_posting)),
            "term extends outside posting section": changed_u32(valid_shard, 84, len(valid_posting) + 1),
            "duplicate document": shard_vector((3, 3), ((FIRST_TERM, valid_posting, 0),)),
            "duplicate term": shard_vector((3,), ((FIRST_TERM, valid_posting, 0), (FIRST_TERM, valid_posting, 0))),
            "posting references absent document": shard_vector((3,), ((FIRST_TERM, posting_vector((4,)), 0),)),
            "posting missing position count": shard_vector((3,), ((FIRST_TERM, valid_posting[:-1], 0),)),
            "posting with trailing bytes": shard_vector((3,), ((FIRST_TERM, valid_posting + b"\0", 0),)),
        }
        fixture.assert_patch_rejected(self, cases, lambda data: fspt.decode_patch(patch_vector(b"\x03", 1, data)))

    def test_cli_compares_membership_and_reports_addition_without_tombstone(self):
        base = membership_shard(RECENT, (1, 3, 4), ((FIRST_TERM, (1, 3, 4)),))
        mini = membership_shard(RECENT, (3, 9), ((SECOND_TERM, (3, 9)),))
        data = patch_vector(bytes.fromhex("03 01"), 2, mini)
        target = membership_shard(RECENT, (1, 3, 9), ((FIRST_TERM, (1,)), (SECOND_TERM, (3, 9))))
        self.assertEqual(fspt.decode_patch(data).appended.documents, (3, 9))

        with tempfile.TemporaryDirectory() as scratch:
            folder = pathlib.Path(scratch)
            patch_file, base_file, target_file = (folder / name for name in ("delta.patch", "base.bin", "target.bin"))
            patch_file.write_bytes(data)
            base_file.write_bytes(base)
            target_file.write_bytes(target)
            arguments = (patch_file, "--role", "recent", "--base", base_file, "--target", target_file)
            result = fixture.run_fspt_cli(*arguments, "--patch-sha256", digest(data), "--base-sha256", digest(base))
            fixture.assert_cli_report(self, result, {
                "appendedWithoutTombstone": [9],
                "tombstones": [3, 4],
                "mergedDocuments": 3,
                "mergedTerms": 2,
                "targetMembershipMatches": True,
                "rankingChecked": False,
            })

            # Preserve the target IDs but put the old term on replaced article 3.
            target_file.write_bytes(membership_shard(RECENT, (1, 3, 9), ((FIRST_TERM, (1, 3)), (SECOND_TERM, (3, 9)))))
            mismatch = fixture.run_fspt_cli(*arguments)
            self.assertEqual(mismatch.returncode, 1, mismatch.stderr)
            self.assertFalse(json.loads(mismatch.stdout)["targetMembershipMatches"])

    def test_cli_rejects_wrong_expected_patch_and_base_digests(self):
        with tempfile.TemporaryDirectory() as scratch:
            folder = pathlib.Path(scratch)
            patch_file, base_file = folder / "delta.patch", folder / "base.bin"
            patch_file.write_bytes(TOMBSTONE_ONLY)
            base_file.write_bytes(membership_shard(RECENT, (1,), ((FIRST_TERM, (1,)),)))
            for option in ("--patch-sha256", "--base-sha256"):
                with self.subTest(option=option):
                    result = fixture.run_fspt_cli(patch_file, "--base", base_file, option, "0" * 64)
                    self.assertEqual((result.returncode, result.stdout), (1, ""))
                    self.assertIn("SHA-256", result.stderr)


if __name__ == "__main__":
    unittest.main()
