"""Pure controls only: never call Linux F_SETLEASE, mmap, fixture Git or VM."""
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("boundaries", ROOT / "tools/operations/probe-file-lease-boundaries.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
MODULE.settings = {"timeoutSeconds": 5}


class LeaseControls(unittest.TestCase):
    def test_successful_set_owns_fd_even_when_get_fails(self):
        owned = set()
        with patch.object(MODULE.fcntl, "fcntl", side_effect=[0, OSError("GET failed")]):
            with self.assertRaises(OSError):
                MODULE.lease(81, owned)
        self.assertEqual(owned, {81})

    def test_failed_unlock_keeps_ownership_until_successful_close(self):
        owned = {81}
        with patch.object(MODULE.fcntl, "fcntl", side_effect=OSError("unlock failed")):
            with self.assertRaises(OSError):
                MODULE.release(81, owned)
        self.assertEqual(owned, {81})
        with patch.object(MODULE.os, "close") as close:
            MODULE.close_owned(81, owned)
        close.assert_called_once_with(81)
        self.assertFalse(owned)

    def test_cleanup_attempts_close_after_unlock_failure_and_keeps_primary(self):
        owned = {81}
        stderr = io.StringIO()
        with patch.object(MODULE.fcntl, "fcntl", side_effect=OSError("unlock failed")), patch.object(MODULE.os, "close") as close, contextlib.redirect_stderr(stderr):
            MODULE.cleanup(None, [81], owned, RuntimeError("original failure"))
        close.assert_called_once_with(81)
        self.assertIn("original failure", stderr.getvalue())
        self.assertFalse(owned)

    def test_plan_default_inspect_requires_hash_closed_fields_owned_taskpaths(self):
        parent = os.environ.get("FSUSBLOG_OPERATIONS_FIXTURE_ROOT", tempfile.gettempdir())
        with tempfile.TemporaryDirectory(prefix="lease-controls-", dir=parent) as root:
            fixtures = Path(root) / "fixtures"
            fixtures.mkdir()
            lock = Path(root) / "task.lock"
            lock.touch()
            source = ROOT / "tools/operations/probe-file-lease-boundaries.py"
            value = {"schema": "fsusblog.local-task-plan.v1", "taskRoot": root, "fixtureDirs": [{"label": "owned", "directory": str(fixtures)}], "minMemoryBytes": 1, "minDiskBytes": 1, "taskLock": str(lock), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "boundarySourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "timeoutSeconds": 5}
            plan = Path(root) / "plan.json"
            plan.write_text(json.dumps(value))
            args = ["--plan", str(plan), "--plan-sha256", hashlib.sha256(plan.read_bytes()).hexdigest()]
            with patch.object(MODULE.fcntl, "fcntl", side_effect=AssertionError("native lease forbidden")), patch.object(MODULE.subprocess, "Popen", side_effect=AssertionError("child forbidden")):
                parsed, actual = MODULE.read_plan(args, ["probe-new-task-fixtures-only"])
                self.assertEqual(parsed.mode, "inspect")
                self.assertEqual(actual, value)
            with self.assertRaises(RuntimeError):
                MODULE.read_plan(["--plan", str(plan), "--plan-sha256", "0" * 64], [])
            # Read access may update atime; custody binds content-changing epochs only.
            data = json.dumps(value).encode("utf8")
            plan.write_bytes(data)
            os.utime(plan, ns=(1, 2))
            _, first_read = MODULE.read_plan(["--plan", str(plan), "--plan-sha256", hashlib.sha256(data).hexdigest()], [])
            self.assertEqual(first_read, value)
            value["unexpected"] = True
            plan.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError, "closed"):
                MODULE.read_plan(["--plan", str(plan), "--plan-sha256", hashlib.sha256(plan.read_bytes()).hexdigest()], [])

    def test_embedded_native_child_sources_compile_without_running(self):
        compile(MODULE.MAPPING, "mapping fixture", "exec")
        tree = ast.parse((ROOT / "tools/operations/probe-file-lease-capability.py").read_text())
        scripts = [node.value.value for node in ast.walk(tree) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "breaker_script" for target in node.targets)]
        self.assertEqual(len(scripts), 1)
        compile(scripts[0], "breaker fixture", "exec")


if __name__ == "__main__":
    unittest.main()
