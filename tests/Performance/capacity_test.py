from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest

from capacity import RATES, ROUTE_WEIGHTS, digest, matrix, private_origin, sealed_inputs, stage


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
            return stage(path, 10500, 40, 100, "runtime-default")[1]

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


class PrivateSupplierEvidence(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.path = Path(work.name)
        self.inputs_path = self.path / "inputs"
        self.inputs_path.mkdir()
        for name in ("fsusblog-v2.tar.gz", "payload.sha256", "wire.schema.json", "load"):
            (self.inputs_path / name).write_text(name)
        self.inputs = sealed_inputs(self.inputs_path)
        self.topology = "direct"
        self.fixture()

    def fixture(self):
        self.target = "http://10.4.3.2:8080" if self.topology == "direct" else "https://[fd12::1]:8443"
        commit, source = "f" * 40, "d" * 64
        self.run = {
            "run_id": "a" * 32, "invocation_id": "b" * 32, "attempt_id": "c" * 32, "owner_pid": "3",
            "server_pid": "5", "database": "fixture", "target": self.target,
            "origin": self.target if self.topology == "direct" else "http://127.0.0.1:9443",
            "proxy_pid": "" if self.topology == "direct" else "17",
            "started_at": self.utc(0), "finished_at": self.utc(500),
            "exit_code": "0", "cleanup": "yes", "last_stage": "finished",
        }
        self.write_properties("outcome.txt", self.run)
        self.write_properties("owner.txt", {**self.run, "postgres_pid": "7", "readiness": "204", "ready_at": self.utc(1)})
        self.write_properties("environment.txt", {"commit": commit, "source_sha256": source})
        (self.path / "source-status.txt").touch()
        (self.path / "server-process.csv").write_text("utc,pid,rss_kib,pcpu\nstart,5,123,1")
        (self.path / "fixture.json").write_text("fixture")
        (self.path / "ca.pem").write_text("lab CA")
        self.write_json("release-input.json", {
            **{key: self.inputs[key] for key in ("archiveSha256", "payloadManifestSha256")},
            "fsusblogCommit": commit, "buildSource": "verified-release-archive",
        })
        self.binding = {
            **self.inputs, "version": 1, "topology": self.topology, "target": self.target,
            "runId": self.run["run_id"], "invocationId": self.run["invocation_id"], "attemptId": self.run["attempt_id"],
            "serverHostId": "8" * 64, "supplierHostId": "9" * 64, "generation": "27",
            "fixtureSha256": digest(self.path / "fixture.json"), "ownerSha256": digest(self.path / "owner.txt"),
            "releaseInputSha256": digest(self.path / "release-input.json"),
            "outcomeSha256": digest(self.path / "outcome.txt"),
            "caSha256": digest(self.path / "ca.pem") if self.topology == "proxy" else None,
            "stages": [],
        }
        self.reports = []
        for index, rate in enumerate(RATES):
            process = index + 50
            first = index * 112 + 2
            report = shared_report()
            identity = {key: self.binding[key] for key in ("target", "generation", "fixtureSha256")}
            report.update(identity, pid=process, targetScope="explicit-private-literal",
                          tlsVersion="TLS 1.3" if self.topology == "proxy" else "", requestedRate=rate,
                          expected=rate * 60, routes=routes(rate, 60), startedAt=self.utc(first + 1),
                          measurementStartedAt=self.utc(first + 34),
                          measurementCompletedAt=self.utc(first + 93.982), finishedAt=self.utc(first + 94),
                          measurementElapsedSeconds=60.00008, supplyBySecond=self.timeline(rate))
            for key in ("producerBefore", "producerAfter"):
                report[key] = {"runtimeMaxProcs": 8}
            report["warmup"].update(identity, pid=process, measurementElapsedSeconds=30,
                                    measurementStartedAt=self.utc(first + 3), measurementCompletedAt=self.utc(first + 33),
                                    supplyBySecond=self.timeline(2000, 30))
            reuse = report["connectionReuse"]
            reuse["requestsAttemptedOnRetained"] = reuse["requestsValidatedOnRetained"] = rate * 60
            self.reports.append(report)
            self.binding["stages"].append({"rate": rate, "supplierPid": process, "exitCode": 0,
                                           "acceptedAt": self.utc(first), "collectedAt": self.utc(first + 95)})
            self.write_stage(index)
        self.write_binding()

    @staticmethod
    def utc(seconds, year=2026):
        return (datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")

    @staticmethod
    def timeline(rate, seconds=60):
        counts = {key: rate for key in ("planned", "schedulerAwake", "admitted", "attemptFinished", "correct")}
        return [{**counts, "dropped": 0, "second": second, "observedOutstandingPeak": 256} for second in range(seconds)]

    def write_properties(self, name, values):
        (self.path / name).write_text("".join(f"{key}={value}\n" for key, value in values.items()))

    def write_json(self, name, data):
        path = self.path / name
        path.write_text(json.dumps(data))
        return path

    def write_stage(self, index):
        name = f"{self.topology}-{RATES[index]}.json"
        self.binding["stages"][index]["reportSha256"] = digest(self.write_json(name, self.reports[index]))

    def write_binding(self):
        self.write_json("private-supplier.json", self.binding)

    def evaluate(self, private=True):
        return matrix(self.path, self.topology, self.inputs if private else None)

    def test_owned_direct_and_tls_are_admitted_with_the_same_numeric_output(self):
        for topology in ("direct", "proxy"):
            with self.subTest(topology=topology):
                self.topology = topology
                self.fixture()
                public = self.evaluate(False)
                private = self.evaluate()
                self.assertEqual(private.pop("privateSupplierEvidence")["target"], self.target)
                self.assertEqual(public, private)

    def test_missing_admission_is_explicit_and_old_numeric_use_still_works(self):
        (self.path / "private-supplier.json").unlink()
        self.assertTrue(self.evaluate(False)["stages"][-1]["numericPeakPassed"])
        with self.assertRaisesRegex(ValueError, "private supplier admission failed.*private-supplier.json"):
            self.evaluate()

    def test_tampered_results_and_actual_input_bytes_fail(self):
        self.reports[-1]["measurementElapsedSeconds"] = 1
        self.write_json("direct-10500.json", self.reports[-1])
        with self.assertRaisesRegex(ValueError, "differs from the raw result"):
            self.evaluate()
        self.fixture()
        for key, name in (("wireSha256", "wire.schema.json"), ("toolSha256", "load"),
                          ("archiveSha256", "fsusblog-v2.tar.gz"), ("payloadManifestSha256", "payload.sha256")):
            with self.subTest(key=key):
                original = (self.inputs_path / name).read_text()
                (self.inputs_path / name).write_text("changed")
                self.inputs = sealed_inputs(self.inputs_path)
                with self.assertRaisesRegex(ValueError, "sealed inputs"):
                    self.evaluate()
                (self.inputs_path / name).write_text(original)
                self.inputs = sealed_inputs(self.inputs_path)
        (self.path / "fixture.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "sealed inputs"):
            self.evaluate()

    def test_copied_report_with_updated_digest_and_wrong_pid_or_time_fails(self):
        for field, value, message in (
            ("pid", 888, "scope, process or transport"),
            ("startedAt", self.utc(10), "outside its current owner interval"),
            ("target", "http://192.168.0.2:1", "scope, process or transport"),
            ("generation", "26", "scope, process or transport"),
            ("measurementElapsedSeconds", 1, "duration differs"),
        ):
            with self.subTest(field=field):
                self.fixture()
                self.reports[-1][field] = value
                self.write_stage(-1)
                self.write_binding()
                with self.assertRaisesRegex(ValueError, message):
                    self.evaluate()

    def test_future_targets_and_duplicated_hosts_fail_at_admission(self):
        self.run["finished_at"] = datetime.now(timezone.utc) + timedelta(days=1)
        self.run["finished_at"] = self.run["finished_at"].isoformat().replace("+00:00", "Z")
        self.write_properties("outcome.txt", self.run)
        self.binding["outcomeSha256"] = digest(self.path / "outcome.txt")
        self.write_binding()
        with self.assertRaisesRegex(ValueError, "private run interval"):
            self.evaluate()
        self.fixture()
        self.binding["supplierHostId"] = self.binding["serverHostId"]
        self.write_binding()
        with self.assertRaisesRegex(ValueError, "host or owner differs"):
            self.evaluate()
        self.fixture()
        self.binding["target"] = "https://10.4.3.2:8080"
        self.write_binding()
        with self.assertRaisesRegex(ValueError, "target, TLS authority or process ownership"):
            self.evaluate()

    def test_same_exact_failure_threshold_in_both_modes(self):
        for dropped in (630, 631):
            with self.subTest(dropped=dropped):
                self.fixture()
                report = self.reports[-1]
                for key in ("home-html", "all"):
                    stats = report["routes"][key]
                    stats.update(sent=stats["sent"] - dropped, ok=stats["ok"] - dropped, dropped=dropped)
                report["routes"]["all"]["httpStatus"]["200"] -= dropped
                report["connectionReuse"]["requestsAttemptedOnRetained"] -= dropped
                report["connectionReuse"]["requestsValidatedOnRetained"] -= dropped
                second = report["supplyBySecond"][-1]
                for key in ("admitted", "attemptFinished", "correct"):
                    second[key] -= dropped
                second["dropped"] = dropped
                self.write_stage(-1)
                self.write_binding()
                for private in (False, True):
                    self.assertEqual(self.evaluate(private)["stages"][-1]["numericPeakPassed"], dropped == 630)

    def test_private_origins_reject_address_aliases(self):
        for origin in ("http://127.0.0.1:80", "http://192.0.2.1:80", "http://localhost:80",
                       "http://[fd12::1%en0]:80", "http://[::ffff:10.4.3.2]:80",
                       "http://10.4.3.2:080", "http://10.4.3.2:80?"):
            with self.subTest(origin=origin):
                self.assertFalse(private_origin(origin, "http"))

    def test_changed_owner_and_tls_authority_fail(self):
        owner = self.path / "owner.txt"
        owner.write_text(owner.read_text() + "other text\n")
        with self.assertRaisesRegex(ValueError, "host or owner differs"):
            self.evaluate()
        self.topology = "proxy"
        self.fixture()
        (self.path / "ca.pem").write_text("some other CA")
        with self.assertRaisesRegex(ValueError, "target, TLS authority or process ownership"):
            self.evaluate()

    def test_planned_counts_cannot_move_between_seconds(self):
        self.reports[-1]["supplyBySecond"][0]["planned"] -= 1
        self.reports[-1]["supplyBySecond"][1]["planned"] += 1
        self.write_stage(-1)
        self.write_binding()
        with self.assertRaisesRegex(ValueError, "producer timeline differs"):
            self.evaluate()
