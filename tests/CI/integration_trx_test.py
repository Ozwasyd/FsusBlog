"""Regression controls derived from real xUnit/VSTest output, not the allowlist."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ci_checks", ROOT / "tools/ci/checks.py")
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ActualIntegrationReport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "integration.trx"
        self.path.write_bytes((ROOT / "tests/CI/fixtures/integration-exclusions.trx").read_bytes())

    def change(self, edit):
        root = ET.parse(self.path).getroot()
        edit(root)
        ET.ElementTree(root).write(self.path, encoding="utf-8", xml_declaration=True)

    def test_actual_class_names_and_zero_skipped_counter(self):
        report = checks.validate_trx(self.path, "integration")
        self.assertEqual((report["total"], report["passed"], len(report["excluded"])), (8, 1, 7))
        self.assertEqual(len(checks.INTEGRATION_EXCLUSIONS), 7)
        self.assertTrue(all(row["coverageGap"] for row in report["excluded"]))

    def test_explicit_skipped_count_is_also_supported(self):
        self.change(lambda root: root.find("t:ResultSummary/t:Counters", checks.NS).set("notExecuted", "7"))
        self.assertEqual(checks.validate_trx(self.path, "integration")["passed"], 1)

    def test_inconsistent_skip_count_is_rejected(self):
        for count in ("1", "6", "8", "-1"):
            with self.subTest(count=count):
                self.change(lambda root: root.find("t:ResultSummary/t:Counters", checks.NS).set("notExecuted", count))
                with self.assertRaises(ValueError):
                    checks.validate_trx(self.path, "integration")

    def test_same_method_in_another_class_cannot_borrow_exclusion(self):
        def change_class(root):
            method = root.findall("t:TestDefinitions/t:UnitTest/t:TestMethod", checks.NS)[1]
            method.set("className", "Different.Namespace." + method.get("className"))
        self.change(change_class)
        with self.assertRaises(ValueError):
            checks.validate_trx(self.path, "integration")

    def test_known_method_failure_is_never_excluded(self):
        self.change(lambda root: root.findall("t:Results/t:UnitTestResult", checks.NS)[1].set("outcome", "Failed"))
        with self.assertRaises(ValueError):
            checks.validate_trx(self.path, "integration")

    def test_real_integration_skips_cannot_pass_unit_profile(self):
        with self.assertRaises(ValueError):
            checks.validate_trx(self.path, "unit")

    def test_zero_skip_counter_does_not_hide_unlisted_skips(self):
        self.change(lambda root: root.findall("t:Results/t:UnitTestResult", checks.NS)[0].set("outcome", "NotExecuted"))
        with self.assertRaises(ValueError):
            checks.validate_trx(self.path, "integration")


if __name__ == "__main__":
    unittest.main()
