import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from capacity import digest
from capacity_test import routes
from launch_gate import evaluate


class LaunchGate(unittest.TestCase):
    rate = 100

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def fixture(self, mode, seconds):
        target = ("http" if mode == "launch-direct" else "https") + "://127.0.0.1:53535"
        (self.root / "environment.txt").write_text(
            f"launch_mode={mode}\nlaunch_rate={self.rate}\ncommit=test\nsupplier_gomaxprocs=runtime-default\n")
        (self.root / "owner.txt").write_text(f"target={target}\n")
        fixture = self.root / "fixture.json"
        fixture.write_text("{}")
        report = dict(target=target, preflight="pass", responses=2402, protocol="HTTP/1.1",
                      requestedRate=self.rate, seconds=seconds, expected=self.rate * seconds,
                      routes=routes(self.rate, seconds), fixtureSha256=digest(fixture),
                      measurementStartedAt="2026-11-25T05:00:00Z")
        self.save(mode, report)
        return report

    def save(self, mode, report):
        (self.root / f"{mode}-{self.rate}.json").write_text(json.dumps(report))

    def test_custom_direct_rate_and_latency_limits(self):
        mode = "launch-direct"
        report = self.fixture(mode, 60)
        self.assertTrue(evaluate(mode, self.rate, self.root)["passed"])
        report["routes"]["home-html"]["p95Ms"] = 26
        self.save(mode, report)
        self.assertFalse(evaluate(mode, self.rate, self.root)["passed"])

    def test_unsent_requests_are_in_budget(self):
        mode = "proxy-launch"
        report = self.fixture(mode, 60)
        for missed, passed in ((6, True), (7, False)):
            report["routes"] = routes(self.rate, 60)
            for name in ("home-html", "all"):
                report["routes"][name]["sent"] -= missed
                report["routes"][name]["ok"] -= missed
            self.save(mode, report)
            self.assertEqual(evaluate(mode, self.rate, self.root)["passed"], passed)

    def test_soak_requires_matching_runtime_evidence(self):
        mode = "proxy-launch-soak"
        report = self.fixture(mode, 900)
        runtime = self.root / "runtime-result.json"
        for started, passed in (("other", False), (report["measurementStartedAt"], True)):
            runtime.write_text(json.dumps(dict(result="verified", durationSeconds=900, loadStart=started)))
            self.assertEqual(evaluate(mode, self.rate, self.root)["passed"], passed)
        report["seconds"] = 60
        self.save(mode, report)
        with self.assertRaises(ValueError):
            evaluate(mode, self.rate, self.root)

    def test_invalid_arguments_exit_before_setup(self):
        destination = self.root / "should-not-exist"
        for mode, rate in (("proxy-launch-soak", "0"), ("launch-direct", "11010"),
                           ("proxy-launch", "109"), ("direct", "100")):
            with self.subTest(mode=mode, rate=rate):
                result = subprocess.run(["bash", str(Path(__file__).with_name("run.sh")),
                                         mode, str(destination), rate], capture_output=True)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
