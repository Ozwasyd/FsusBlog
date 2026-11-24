#!/usr/bin/env python3
"""Fail-closed CI result validation. No network or third-party dependencies."""
from __future__ import annotations

import argparse
import hashlib
import re
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
    "MarkdownExportPostgresTests.PdfExportsOnlyTheAuthorizedSelectedRevision": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.DocumentExportPostgresTests.CancelsAnOwnedRunningPdfAndReleasesItsRendererBeforeTimeout": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.DocumentExportPostgresTests.RestartsAfterLeaseLossInterruptsRealPdfAndFinishesTheQueuedJob": "macOS PDF renderer",
    "FsusBlog.V2.Integration.Tests.DocumentExportPostgresTests.RestartsAfterSigtermInterruptsRealPdfAndFinishesTheQueuedJob": "macOS PDF renderer",
    "PluginPreviewPostgresTests.SignedWorkerPreviewsOnlyTheCurrentSavedAuthorRevisionOverHttps": "operator-staged Linux ARM64 plugin worker",
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
                "executed": passed}
    for key, value in expected.items():
        if int(counters.get(key, "-1")) != value:
            raise ValueError(f"TRX counter mismatch: {key} must be {value}.")
    # VSTest 18.5.1 writes notExecuted=0 even when xUnit emits NotExecuted
    # result rows. Count and authorize every skipped row above; require the
    # independent total/executed/passed counters to reconcile either encoding.
    if int(counters.get("notExecuted", "-1")) not in {0, len(skipped)}:
        raise ValueError("TRX notExecuted counter does not match its result rows.")
    if passed == 0:
        raise ValueError("An all-skipped run cannot pass.")
    return {"status": "passed", "profile": profile, "total": len(results),
            "passed": passed, "excluded": skipped}


def validate_caddy(manifest: Path, archive: Path, manifest_sha256: str) -> dict:
    """Caddy uses SHA-512 archive entries, inside a SHA-256-pinned manifest."""
    payload = manifest.read_bytes()
    if hashlib.sha256(payload).hexdigest() != manifest_sha256:
        raise ValueError("Caddy checksum manifest does not match the pinned SHA-256.")
    matches = []
    for line in payload.decode("ascii").splitlines():
        entry = re.fullmatch(r"([0-9a-fA-F]{128}) [ *](.+)", line)
        if entry and entry.group(2) == archive.name:
            matches.append(entry.group(1).lower())
    if len(matches) != 1:
        raise ValueError("Caddy manifest must contain exactly one SHA-512 archive entry.")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha512").hexdigest()
    if actual != matches[0]:
        raise ValueError("Caddy archive does not match its authenticated SHA-512.")
    return {"status": "verified", "archive": archive.name, "sha512": actual}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("required")
    trx = sub.add_parser("trx")
    trx.add_argument("path", type=Path)
    trx.add_argument("--profile", choices=["unit", "integration"], default="unit")
    caddy = sub.add_parser("caddy")
    caddy.add_argument("manifest", type=Path)
    caddy.add_argument("archive", type=Path)
    caddy.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "required":
            report = validate_needs(json.loads(os.environ.get("CI_NEEDS", "null")))
        elif args.command == "caddy":
            report = validate_caddy(args.manifest, args.archive, args.manifest_sha256)
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
