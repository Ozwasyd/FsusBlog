#!/usr/bin/env python3
"""Recompute one single-host launch attempt; not the independent two-host quorum."""

import argparse
import json
from pathlib import Path

from capacity import digest, read_properties, stage

MODES = {"launch-direct": (60, 25, 75), "proxy-launch": (60, 40, 100),
         "proxy-launch-soak": (900, 40, 100)}


def evaluate(mode, rate, evidence):
    seconds, p95, p99 = MODES[mode]
    path = evidence / f"{mode}-{rate}.json"
    environment = read_properties(evidence / "environment.txt")
    report = json.loads(path.read_text())
    owner = read_properties(evidence / "owner.txt")
    if (environment.get("launch_mode") != mode or environment.get("launch_rate") != str(rate)
            or owner.get("target", owner.get("origin")) != report["target"]
            or not report["target"].startswith("http://" if mode == "launch-direct" else "https://")):
        raise ValueError("Launch topology, rate or target does not match the run receipt.")
    fixture, numeric = stage(path, rate, p95, p99, environment["supplier_gomaxprocs"],
                             report, seconds=seconds)
    if fixture != digest(evidence / "fixture.json"):
        raise ValueError("Fixture digest does not match the run.")
    failures = numeric["errors"] + numeric["dropped"] + numeric["unreached"]
    rows = (numeric, *numeric["routes"].values())
    latency_ok = all(0 < row["p95Ms"] <= p95 and 0 < row["p99Ms"] <= p99 for row in rows)
    runtime_ok = True
    if seconds == 900:
        runtime = json.loads((evidence / "runtime-result.json").read_text())
        runtime_ok = (runtime.get("result") == "verified" and runtime.get("durationSeconds") == seconds
                      and runtime.get("loadStart") == report["measurementStartedAt"])
    return {
        "mode": mode, "commit": environment["commit"], "fixtureSha256": fixture,
        "requestedRate": rate, "seconds": seconds, "numeric": numeric,
        "latencyPassed": latency_ok, "runtimePassed": runtime_ok if seconds == 900 else None,
        "passed": latency_ok and runtime_ok and failures * 1000 <= rate * seconds,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=MODES)
    parser.add_argument("rate", type=int)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    if not 10 <= args.rate <= 11000 or args.rate % 10:
        parser.error("rate must be a multiple of 10 in 10..11000")
    try:
        result = evaluate(args.mode, args.rate, args.evidence)
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        return 1
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
