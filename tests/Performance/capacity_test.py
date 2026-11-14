import json
from pathlib import Path
import tempfile
import unittest

from capacity import ROUTE_WEIGHTS, stage


def routes(rate, seconds):
    planned = rate * seconds
    by_route = {
        name: {"sent": planned * share // 100, "dropped": 0, "ok": planned * share // 100, "p95Ms": 10, "p99Ms": 20}
        for name, share in ROUTE_WEIGHTS.items()
    }
    by_route["all"] = {"sent": planned, "dropped": 0, "ok": planned, "p95Ms": 10, "p99Ms": 20,
                      "errors": {}, "httpStatus": {"200": planned}}
    return by_route


def shared_report():
    binding = {"pid": 1234, "target": "https://127.0.0.1:44321", "generation": "27", "fixtureSha256": "fixture"}
    return {**binding, "connectionPolicy": "carry-from-warmup", "preflight": "pass", "responses": 2402,
            "protocol": "HTTP/1.1", "requestedRate": 10500, "seconds": 60, "expected": 630000,
            "routes": routes(10500, 60), "measurementStartedAt": "2026-11-15T02:00:30.123456789Z",
            "connectionReuse": {"retainedAfterWarmup": 256, "attemptedOnRetained": 256, "validatedOnRetained": 220,
                                "requestsAttemptedOnRetained": 630000, "requestsValidatedOnRetained": 629000},
            "warmup": {**binding, "requestedRate": 2000, "seconds": 30, "expected": 60000,
                       "routes": routes(2000, 30), "schedulerUnreached": 0,
                       "measurementStartedAt": "2026-11-15T02:00:00.123456789Z",
                       "measurementCompletedAt": "2026-11-15T02:00:30.123456Z"}}


class WarmupEvidence(unittest.TestCase):
    def evaluate(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proxy-10500.json"
            path.write_text(json.dumps(data))
            return stage(path, 10500, 40, 100)[1]

    def test_keeps_error_and_request_details_from_both_windows(self):
        report = self.evaluate(shared_report())
        self.assertTrue(report["numericPeakPassed"])
        self.assertEqual(report["connectionPolicy"], "carry-from-warmup")
        self.assertEqual(report["warmup"], {"correct": 60000, "dropped": 0, "unreached": 0, "errors": 0})
        self.assertEqual(report["connectionReuse"]["validatedOnRetained"], 220)

    def test_rejects_different_process_overlap_or_unproven_reuse(self):
        for container, key, value in (
            ("warmup", "pid", 111),
            ("warmup", "measurementCompletedAt", "2026-11-15T02:00:31Z"),
            ("connectionReuse", "validatedOnRetained", 0),
            ("connectionReuse", "requestsAttemptedOnRetained", 630001),
        ):
            with self.subTest(key=key):
                report = shared_report()
                report[container][key] = value
                with self.assertRaisesRegex(ValueError, "reused warmup evidence"):
                    self.evaluate(report)
