"""Negative controls for CI aggregation and real-test report validation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ci_checks", ROOT / "tools/ci/checks.py")
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ResultGates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test.trx"

    def report(self, outcomes=("Passed",), names=None, counters=None, summary="Completed"):
        ns = "{" + checks.NS["t"] + "}"
        root = ET.Element(ns + "TestRun")
        definitions = ET.SubElement(root, ns + "TestDefinitions")
        results = ET.SubElement(root, ns + "Results")
        for i, outcome in enumerate(outcomes):
            name = names[i] if names else f"Example.Tests.Check{i}"
            cls, method = name.rsplit(".", 1)
            test = ET.SubElement(definitions, ns + "UnitTest", id=str(i))
            ET.SubElement(test, ns + "TestMethod", className=cls, name=method)
            ET.SubElement(results, ns + "UnitTestResult", testId=str(i), executionId=f"exec-{i}",
                          testName=name, outcome=outcome)
        result_summary = ET.SubElement(root, ns + "ResultSummary", outcome=summary)
        values = {"total": len(outcomes), "passed": outcomes.count("Passed"),
                  "failed": outcomes.count("Failed"), "notExecuted": outcomes.count("NotExecuted"),
                  "executed": len(outcomes) - outcomes.count("NotExecuted")}
        values.update(counters or {})
        ET.SubElement(result_summary, ns + "Counters", **{k: str(v) for k, v in values.items()})
        ET.ElementTree(root).write(self.path, encoding="utf-8", xml_declaration=True)
        return root

    def test_successful_units(self):
        self.report(("Passed", "Passed"))
        self.assertEqual(checks.validate_trx(self.path, "unit")["passed"], 2)

    def test_zero_tests_are_rejected(self):
        self.report(())
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "unit")

    def test_missing_report_is_rejected(self):
        with self.assertRaises(OSError): checks.validate_trx(self.path, "unit")

    def test_failed_result_is_rejected(self):
        self.report(("Passed", "Failed"))
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "integration")

    def test_failed_summary_is_rejected(self):
        self.report(summary="Failed")
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "unit")

    def test_arbitrary_skipped_integration_is_rejected(self):
        self.report(("Passed", "NotExecuted"))
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "integration")

    def test_known_exclusions_are_reported_not_counted_as_passed(self):
        for name in checks.INTEGRATION_EXCLUSIONS:
            with self.subTest(name=name):
                self.report(("Passed", "NotExecuted"), ("Example.Tests.Real", name))
                result = checks.validate_trx(self.path, "integration")
                self.assertEqual(result["passed"], 1)
                self.assertEqual(result["excluded"][0]["test"], name)

    def test_exclusions_do_not_apply_to_units(self):
        self.report(("Passed", "NotExecuted"), ("Example.Tests.Real", next(iter(checks.INTEGRATION_EXCLUSIONS))))
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "unit")

    def test_all_skipped_is_rejected(self):
        self.report(("NotExecuted",), (next(iter(checks.INTEGRATION_EXCLUSIONS)),))
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "integration")

    def test_counter_tampering_is_rejected(self):
        for counter in ("total", "executed", "passed", "failed", "notExecuted"):
            with self.subTest(counter=counter):
                self.report(counters={counter: 999})
                with self.assertRaises(ValueError): checks.validate_trx(self.path, "unit")

    def test_duplicate_execution_is_rejected(self):
        root = self.report(("Passed", "Passed"))
        root.findall("t:Results/t:UnitTestResult", checks.NS)[1].set("executionId", "exec-0")
        ET.ElementTree(root).write(self.path)
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "unit")

    def test_missing_summary_is_rejected(self):
        root = self.report()
        root.remove(root.find("t:ResultSummary", checks.NS))
        ET.ElementTree(root).write(self.path)
        with self.assertRaises(ValueError): checks.validate_trx(self.path, "unit")

    def test_cli_returns_failure_for_malformed_xml(self):
        self.path.write_text("not XML")
        result = subprocess.run(["python3", "-B", str(ROOT / "tools/ci/checks.py"), "trx", str(self.path)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("CI gate rejected", result.stderr)

    def test_required_success(self):
        self.assertEqual(checks.validate_needs({"source": {"result": "success"}, "stack": {"result": "success"}}),
                         {"source": "success", "stack": "success"})

    def test_missing_or_extra_required_job_is_rejected(self):
        for value in (None, [], {}, {"source": {"result": "success"}},
                      {"source": {}, "stack": {}, "extra": {}}):
            with self.subTest(value=value), self.assertRaises(ValueError): checks.validate_needs(value)

    def test_every_non_success_required_state_is_rejected(self):
        for state in ("failure", "cancelled", "skipped", "neutral", "", None):
            with self.subTest(state=state), self.assertRaises(ValueError):
                checks.validate_needs({"source": {"result": "success"}, "stack": {"result": state}})

    def test_malformed_required_job_is_rejected(self):
        with self.assertRaises(ValueError):
            checks.validate_needs({"source": {"result": "success"}, "stack": "success"})


if __name__ == "__main__":
    unittest.main()
