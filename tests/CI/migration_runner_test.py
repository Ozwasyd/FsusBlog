"""Prebuilt-CLI selection controls, not substitutes for real database verification."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class MigrationRunner(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls.jsonl"
        self.cli = self.root / "release CLI.dll"
        self.cli.write_text("built fixture")
        self.env = dict(os.environ, PATH=str(self.bin) + ":" + os.environ["PATH"],
                        TMPDIR=str(self.root), PG_TOOLS_DIR=str(self.bin),
                        PGHOST="fixture", PGUSER="fixture", FSUSBLOG_TEST_DB="Host=fixture",
                        FSUSBLOG_TEST_CLI_DLL=str(self.cli), DOTNET_BIN=str(self.bin / "dotnet"),
                        CI_CALLS=str(self.calls))
        for name in ("psql", "pg_dump", "pg_restore", "xxd", "rg"):
            self.tool(name, 'import sys; sys.exit(0)')
        # A unique name is sufficient for selection tests; no database is contacted.
        self.tool("openssl", 'print("fixture")')
        self.tool("dotnet", '''import json, os, sys
with open(os.environ["CI_CALLS"], "a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
print("intentional fixture stop", file=sys.stderr)
sys.exit(19)
''')
        # The first expected-failure grep deliberately fails, ending the simulation.
        self.tool("rg", 'import sys; sys.exit(1)')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env python3\n" + body + "\n")
        path.chmod(0o755)

    def run_script(self):
        return subprocess.run(["bash", str(ROOT / "tests/Integration/Migration/verify.sh")],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_prebuilt_cli_is_executed_without_restore_or_build(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stderr)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(calls, [[str(self.cli), "verify"]])
        self.assertIn("intentional fixture stop", result.stderr)
        self.assertEqual(list(self.root.glob("fsusv2-cli.*")), [])

    def test_missing_prebuilt_cli_fails_without_build_fallback(self):
        self.cli.unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Missing built CLI", result.stderr)
        self.assertFalse(self.calls.exists())
        self.assertEqual(list(self.root.glob("fsusv2-cli.*")), [])


if __name__ == "__main__":
    unittest.main()
