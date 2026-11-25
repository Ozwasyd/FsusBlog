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


def ensure(condition, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_needs(needs: object) -> dict[str, str]:
    ensure(isinstance(needs, dict) and set(needs) == {"source", "stack"}, "Required job set must be exactly source and stack.")
    results = {name: value.get("result") if isinstance(value, dict) else None for name, value in needs.items()}
    ensure(all(value == "success" for value in results.values()), f"Required jobs did not all succeed: {results}")
    return results


def validate_trx(path: Path, profile: str) -> dict:
    ensure(profile in {"unit", "integration"}, "Unknown TRX profile.")
    root = ET.parse(path).getroot()
    results = root.findall("t:Results/t:UnitTestResult", NS)
    summary = root.find("t:ResultSummary", NS)
    counters = root.find("t:ResultSummary/t:Counters", NS)
    ensure(results and summary is not None and counters is not None, "TRX is missing results or its summary; zero tests cannot pass.")
    ensure(summary.get("outcome") in {"Completed", "Passed"}, f"Unsuccessful TRX summary: {summary.get('outcome')}")
    definitions = {
        test.get("id"): f"{method.get('className')}.{method.get('name')}"
        for test in root.findall("t:TestDefinitions/t:UnitTest", NS)
        if (method := test.find("t:TestMethod", NS)) is not None
    }
    allowed = INTEGRATION_EXCLUSIONS if profile == "integration" else {}
    passed, skipped, executions = 0, [], set()
    for result in results:
        execution = result.get("executionId")
        ensure(execution and execution not in executions, "Missing or duplicate TRX execution ID.")
        executions.add(execution)
        name = definitions.get(result.get("testId"), result.get("testName", ""))
        outcome = result.get("outcome")
        if outcome == "Passed":
            passed += 1
        elif outcome == "NotExecuted" and name in allowed:
            skipped.append({"test": name, "coverageGap": allowed[name]})
        else:
            raise ValueError(f"Unexpected test outcome {outcome}: {name}")
    for key, value in {"total": len(results), "passed": passed, "failed": 0, "executed": passed}.items():
        ensure(int(counters.get(key, "-1")) == value, f"TRX counter mismatch: {key} must be {value}.")
    # VSTest 18.5.1 writes notExecuted=0 even when xUnit emits NotExecuted
    # result rows. Count and authorize every skipped row above; require the
    # independent total/executed/passed counters to reconcile either encoding.
    ensure(int(counters.get("notExecuted", "-1")) in {0, len(skipped)}, "TRX notExecuted counter does not match its result rows.")
    ensure(passed > 0, "An all-skipped run cannot pass.")
    return {"status": "passed", "profile": profile, "total": len(results), "passed": passed, "excluded": skipped}


def validate_caddy(manifest: Path, archive: Path, manifest_sha256: str) -> dict:
    """Caddy uses SHA-512 archive entries, inside a SHA-256-pinned manifest."""
    payload = manifest.read_bytes()
    ensure(hashlib.sha256(payload).hexdigest() == manifest_sha256, "Caddy checksum manifest does not match the pinned SHA-256.")
    matches = [
        entry.group(1).lower()
        for line in payload.decode("ascii").splitlines()
        if (entry := re.fullmatch(r"([0-9a-fA-F]{128}) [ *](.+)", line)) and entry.group(2) == archive.name
    ]
    ensure(len(matches) == 1, "Caddy manifest must contain exactly one SHA-512 archive entry.")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha512").hexdigest()
    ensure(actual == matches[0], "Caddy archive does not match its authenticated SHA-512.")
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
