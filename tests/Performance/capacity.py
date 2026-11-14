#!/usr/bin/env python3
"""Evaluate numeric gates for completed P2 hot-read matrices."""

import argparse
import csv
import json
from pathlib import Path


RATES = (2000, 5000, 8000, 10500)
ROUTE_WEIGHTS = {"home-html": 20, "detail-html": 30, "home-aeds": 20, "detail-aeds": 30}
SECONDS = 60


def read_properties(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)


def stage(path, rate, p95_limit, p99_limit):
    report = json.loads(path.read_text())
    expected = rate * SECONDS
    by_route = report["routes"]
    totals = by_route["all"]
    if (
        report["preflight"] != "pass"
        or report["responses"] != 2402
        or report["protocol"] != "HTTP/1.1"
        or (report["requestedRate"], report["seconds"], report["expected"]) != (rate, SECONDS, expected)
    ):
        raise ValueError(f"{path}: workload or preflight differs from the frozen protocol")
    if any(totals[k] != sum(by_route[route][k] for route in ROUTE_WEIGHTS) for k in ("sent", "dropped", "ok")):
        raise ValueError(f"{path}: route totals do not reconcile")
    unreached = expected - totals["sent"] - totals["dropped"]
    if unreached < 0 or report.get("schedulerUnreached", unreached) != unreached:
        raise ValueError(f"{path}: scheduled counts do not reconcile")
    if not unreached and any(
        by_route[route]["sent"] + by_route[route]["dropped"] != expected * share // 100
        for route, share in ROUTE_WEIGHTS.items()
    ):
        raise ValueError(f"{path}: request mix differs from the frozen protocol")
    request_errors = totals["sent"] - totals["ok"]
    if (
        request_errors != sum(totals["errors"].values()) or request_errors < 0
        or totals["ok"] > totals["httpStatus"].get("200", 0)
    ):
        raise ValueError(f"{path}: failed attempts do not reconcile")
    supply = report.get("supplyBySecond")
    if supply:
        supply_totals = {"planned": expected, "schedulerAwake": expected - unreached,
                         "admitted": totals["sent"], "dropped": totals["dropped"],
                         "attemptFinished": totals["sent"], "correct": totals["ok"]}
        if any(sum(row[key] for row in supply) != value for key, value in supply_totals.items()):
            raise ValueError(f"{path}: producer timeline does not reconcile")
    actual_rate = totals["ok"] / SECONDS
    failures = totals["dropped"] + request_errors + unreached
    per_route = {key: {k: by_route[key][k] for k in ("ok", "p95Ms", "p99Ms")} for key in ROUTE_WEIGHTS}
    out = {
        "plannedRate": rate,
        "correctPerSecond": actual_rate,
        "correct": totals["ok"],
        "errors": request_errors,
        "dropped": totals["dropped"],
        "unreached": unreached,
        "failurePercent": failures * 100 / expected,
        "p95Ms": totals["p95Ms"],
        "p99Ms": totals["p99Ms"],
        "routes": per_route,
    }
    if supply:
        out["dropSeconds"] = [row for row in supply if row["dropped"]]
    if rate == RATES[-1]:
        out["numericPeakPassed"] = (
            actual_rate > 10000
            and failures * 1000 <= expected
            and all(0 < row["p95Ms"] <= p95_limit and 0 < row["p99Ms"] <= p99_limit
                    for row in (*per_route.values(), totals))
        )
    return report["fixtureSha256"], out


def matrix(directory, topology):
    outcome = read_properties(directory / "outcome.txt")
    environment = read_properties(directory / "environment.txt")
    if outcome.get("exit_code") != "0" or outcome.get("cleanup") != "yes" or outcome.get("last_stage") != "finished":
        raise ValueError(f"{directory}: runner failed or cleanup is incomplete")
    if (directory / "source-status.txt").read_text():
        raise ValueError(f"{directory}: requires a clean candidate")
    p95_limit, p99_limit = (25, 75) if topology == "direct" else (40, 100)
    stages = [stage(directory / f"{topology}-{rate}.json", rate, p95_limit, p99_limit) for rate in RATES]
    fixture = stages[0][0]
    if any(digest != fixture for digest, _ in stages):
        raise ValueError(f"{directory}: fixture differs between stages")
    with (directory / "server-process.csv").open(newline="") as file:
        rss = max(int(row["rss_kib"]) for row in csv.DictReader(file)
                  if row["pid"] == outcome["server_pid"])
    return {
        "topology": topology,
        "commit": environment["commit"],
        "sourceSha256": environment["source_sha256"],
        "fixtureSha256": fixture,
        "runId": outcome["run_id"],
        "startedAt": outcome["started_at"],
        "finishedAt": outcome["finished_at"],
        "serverRssPeakKiB": rss,
        "stages": [report for _, report in stages],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--direct", type=Path, action="append", default=[])
    parser.add_argument("--proxy", type=Path, action="append", default=[])
    arguments = parser.parse_args()
    matrices = [matrix(path, kind) for kind, paths in (("direct", arguments.direct), ("proxy", arguments.proxy))
                for path in paths]
    if not matrices:
        parser.error("provide at least one completed direct or proxy matrix")
    coordinates = {(item["commit"], item["sourceSha256"], item["fixtureSha256"]) for item in matrices}
    ids = {item["runId"] for item in matrices}
    if len(coordinates) != 1 or len(ids) != len(matrices):
        parser.error("matrices must use the same source and fixture and have distinct owners")
    print(json.dumps(matrices, indent=2))


if __name__ == "__main__":
    main()
