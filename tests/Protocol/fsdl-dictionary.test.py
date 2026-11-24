#!/usr/bin/env python3
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest

from tool_module_fixture import load_tool_module


COMPILER = pathlib.Path(__file__).resolve().parents[2] / "tools/fsdl-dictionary.py"
fsdl = load_tool_module("fsdl_dictionary", COMPILER)


class FsdlDictionaryTests(unittest.TestCase):
    def test_fixed_vector_preserves_trie_order_frequencies_and_stopwords(self):
        golden = bytes.fromhex("""
            4653444c 02000000 05000000 04000000 04000000
            00000000 03000000 ffffffff 00000000
            03000000 00000000 00000000 00000000
            03000000 01000000 01000000 00000000
            04000000 00000000 02000000 00000000
            04000000 00000000 03000000 00000000
            61000000 01000000 2d4e0000 02000000
            84760000 04000000 fd560000 03000000
            00000000 0100 0000 02000000 01000000
            01000000 0300 0000 03000000 01000000
            04000000 0600 0100 05000000 02000000
            0a000000 0300 0100 01000000 01000000
            0d000000 61 e4b8ad e4b8ade59bbd e79a84
        """)
        words = {"中国": 5, "中": 3, "a": 2}
        self.assertEqual(fsdl.compile_lexicon({"words": words, "stopwords": ["的", "中国"]}), golden)

    def test_pinned_artifact_under_independent_table_and_lookup_reader(self):
        source = json.loads(fsdl.LEXICON.read_text(encoding="utf-8"))
        data = fsdl.compile_lexicon(source)
        magic, version, node_count, edge_count, term_count = struct.unpack_from("<4sIIII", data)
        self.assertEqual((magic, version, node_count - 1), (b"FSDL", 2, edge_count))
        edges_at = 20 + node_count * 16
        terms_at = edges_at + edge_count * 8
        strings_size_at = terms_at + term_count * 16
        strings = data[strings_size_at + 4:]
        self.assertEqual(struct.unpack_from("<I", data, strings_size_at)[0], len(strings))

        words = source["words"]
        stops = set(source["stopwords"])
        expected = sorted(words.keys() | stops, key=lambda word: word.encode("utf-8"))
        self.assertEqual(term_count, len(expected))
        previous = 0
        for index, word in enumerate(expected):
            start, length, flag, frequency, scalars = struct.unpack_from("<IHHII", data, terms_at + 16 * index)
            self.assertEqual((start, flag, frequency, scalars), (previous, int(word in stops), words.get(word, 1), len(word)))
            previous += length
            self.assertEqual(strings[start:previous].decode("utf-8"), word)
            current = 0
            for character in word:
                edge_start, count, _, reserved = struct.unpack_from("<IIII", data, 20 + 16 * current)
                self.assertEqual(reserved, 0)
                children = [struct.unpack_from("<II", data, edges_at + 8 * edge) for edge in range(edge_start, edge_start + count)]
                self.assertEqual(children, sorted(set(children)))
                current = dict(children)[ord(character)]
                self.assertTrue(0 < current < node_count)
            self.assertEqual(struct.unpack_from("<I", data, 20 + 16 * current + 8)[0], index)
        self.assertEqual(previous, len(strings))

    def test_cli_refuses_overwrite_or_altered_artifact(self):
        def invoke(action, target):
            return subprocess.run([sys.executable, str(COMPILER), action, str(target)], capture_output=True)

        with tempfile.TemporaryDirectory() as scratch:
            target = pathlib.Path(scratch) / "lexicon.fsdl"
            exported = invoke("export", target)
            self.assertEqual(exported.returncode, 0, exported.stderr)
            self.assertEqual(exported.stdout, invoke("verify", target).stdout)
            self.assertEqual(invoke("export", target).returncode, 1)
            target.write_bytes(target.read_bytes() + b"\0")
            self.assertEqual(invoke("verify", target).returncode, 1)


if __name__ == "__main__":
    unittest.main()
