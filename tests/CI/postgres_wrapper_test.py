"""Wrapper lifecycle tests use fake processes, not application/database acceptance."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PostgresWrapper(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.state = self.root / "started"
        self.env = dict(os.environ, PATH=str(self.bin) + ":" + os.environ["PATH"],
                        PG_TOOLS_DIR=str(self.bin), FAKE_PG_STATE=str(self.state))
        self.tool("id", 'echo 1001')
        self.tool("postgres", 'echo "postgres (PostgreSQL) 18.1"')
        self.tool("initdb", 'mkdir -p "$2"')
        self.tool("psql", 'echo 180001')
        self.tool("pg_ctl", '''
case "${*: -1}" in
  start) touch "$FAKE_PG_STATE" ;;
  stop) [[ ${FAKE_STOP_FAIL:-0} != 1 ]] || exit 1; rm -f "$FAKE_PG_STATE" ;;
  status) test -e "$FAKE_PG_STATE" ;;
  *) exit 2 ;;
esac
''')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n")
        path.chmod(0o755)

    def run_wrapper(self, script):
        return subprocess.run(["bash", str(ROOT / "tools/ci/with-postgres.sh"), "bash", "-c", script],
                              env=self.env, capture_output=True, text=True, timeout=15)

    def test_success_uses_private_socket_and_cleans_up(self):
        self.env.update(PGHOST="production.invalid", FSUSBLOG_DB="production.invalid", PGPASSWORD="wrong")
        result = self.run_wrapper('test "$PGHOST" != production.invalid; test -z "${FSUSBLOG_DB:-}"; '
                                  'test -z "${PGPASSWORD:-}"; test -d "$PGHOST"; '
                                  'test "$FSUSBLOG_TEST_PGHOST" = "$PGHOST"; test "$PGPORT" = 55432')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.state.exists())

    def test_command_failure_is_preserved_and_cleaned(self):
        result = self.run_wrapper("exit 7")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertFalse(self.state.exists())

    def test_cleanup_failure_cannot_be_green(self):
        self.env["FAKE_STOP_FAIL"] = "1"
        result = self.run_wrapper("true")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PostgreSQL cleanup failed", result.stderr)
        # The wrapper intentionally retains failed-cleanup data. Remove this fake fixture only.
        prefix = "PostgreSQL cleanup failed: "
        for line in result.stderr.splitlines():
            if line.startswith(prefix):
                import shutil
                path = Path(line[len(prefix):])
                self.assertTrue(str(path).startswith("/tmp/fsus-ci-pg."))
                shutil.rmtree(path)

    def test_wrong_postgres_major_is_rejected(self):
        self.tool("postgres", 'echo "postgres (PostgreSQL) 17.6"')
        result = self.run_wrapper("true")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.state.exists())

    def test_root_is_rejected(self):
        self.tool("id", 'echo 0')
        result = self.run_wrapper("true")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
