#!/usr/bin/env python3
"""Fail-closed CI result validation. No network or third-party dependencies."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

NS = {"t": "http://microsoft.com/schemas/VisualStudio/TeamTest/2010"}
# These are coverage exclusions, NOT successful tests or release qualification.
# Exact method names prevent a new environment-dependent test silently going green.
INTEGRATION_EXCLUSIONS = {
    "FsusBlog.V2.Integration.Tests.PrivateMediaPostgresTests.PdfIncludesOnlyApprovedSavedImagesAndPinsTheirOrder": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.MarkdownExportPostgresTests.PdfExportsOnlyTheAuthorizedSelectedRevision": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.DocumentExportPdfPostgresTests.CancelsAnOwnedRunningPdfAndReleasesItsRendererBeforeTimeout": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.DocumentExportPdfPostgresTests.RestartsAfterLeaseLossInterruptsRealPdfAndFinishesTheQueuedJob": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.DocumentExportPdfPostgresTests.RestartsAfterSigtermInterruptsRealPdfAndFinishesTheQueuedJob": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.PluginPreviewPostgresTests.SignedWorkerPreviewsOnlyTheCurrentSavedAuthorRevisionOverHttps": "operator-staged Linux ARM64 plugin worker",
    "FsusBlog.V2.Integration.Tests.NightlyFixturePostgresTests.WritePlannedArticles": "separate C11 scale fixture",
}


def validate_needs(needs: object) -> dict[str, str]:
    expected = {"source", "stack"}
    if not isinstance(needs, dict) or set(needs) != expected:
        raise ValueError("Required job set must be exactly source and stack.")
    results = {name: value.get("result") if isinstance(value, dict) else None
               for name, value in needs.items()}
    if any(value != "success" for value in results.values()):
        raise ValueError(f"Required jobs did not all succeed: {results}")
    return results


def validate_trx(path: Path, profile: str) -> dict:
    if profile not in {"unit", "integration"}:
        raise ValueError("Unknown TRX profile.")
    root = ET.parse(path).getroot()
    results = root.findall("t:Results/t:UnitTestResult", NS)
    summary = root.find("t:ResultSummary", NS)
    counters = root.find("t:ResultSummary/t:Counters", NS)
    if not results or summary is None or counters is None:
        raise ValueError("TRX is missing results or its summary; zero tests cannot pass.")
    if summary.get("outcome") not in {"Completed", "Passed"}:
        raise ValueError(f"Unsuccessful TRX summary: {summary.get('outcome')}")
    definitions = {}
    for test in root.findall("t:TestDefinitions/t:UnitTest", NS):
        method = test.find("t:TestMethod", NS)
        if method is not None:
            definitions[test.get("id")] = f"{method.get('className')}.{method.get('name')}"
    allowed = INTEGRATION_EXCLUSIONS if profile == "integration" else {}
    passed, skipped, executions = 0, [], set()
    for result in results:
        execution = result.get("executionId")
        if not execution or execution in executions:
            raise ValueError("Missing or duplicate TRX execution ID.")
        executions.add(execution)
        name = definitions.get(result.get("testId"), result.get("testName", ""))
        outcome = result.get("outcome")
        if outcome == "Passed":
            passed += 1
        elif outcome == "NotExecuted" and name in allowed:
            skipped.append({"test": name, "coverageGap": allowed[name]})
        else:
            raise ValueError(f"Unexpected test outcome {outcome}: {name}")
    expected = {"total": len(results), "passed": passed, "failed": 0,
                "notExecuted": len(skipped), "executed": passed}
    for key, value in expected.items():
        if int(counters.get(key, "-1")) != value:
            raise ValueError(f"TRX counter mismatch: {key} must be {value}.")
    if passed == 0:
        raise ValueError("An all-skipped run cannot pass.")
    return {"status": "passed", "profile": profile, "total": len(results),
            "passed": passed, "excluded": skipped}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("required")
    trx = sub.add_parser("trx")
    trx.add_argument("path", type=Path)
    trx.add_argument("--profile", choices=["unit", "integration"], default="unit")
    args = parser.parse_args()
    try:
        if args.command == "required":
            report = validate_needs(json.loads(os.environ.get("CI_NEEDS", "null")))
        else:
            report = validate_trx(args.path, args.profile)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if args.command == "trx":
            args.path.with_suffix(".summary.json").write_text(json.dumps(report, indent=2) + "\n")
        return 0
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"CI gate rejected: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
