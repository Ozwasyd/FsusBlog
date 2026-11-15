#!/usr/bin/env python3
"""Evaluate numeric gates for completed P2 hot-read matrices."""

import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
from ipaddress import ip_address, ip_network
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


RATES = (2000, 5000, 8000, 10500)
ROUTE_WEIGHTS = {"home-html": 20, "detail-html": 30, "home-aeds": 20, "detail-aeds": 30}
SECONDS = 60


def read_properties(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)


def stage(path, rate, p95_limit, p99_limit, supplier_procs, report=None):
    if report is None:
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
    if supplier_procs != "runtime-default" and (
        not supplier_procs.isascii() or not supplier_procs.isdecimal() or int(supplier_procs) < 1
        or any(report.get(key, {}).get("runtimeMaxProcs") != int(supplier_procs)
               for key in ("producerBefore", "producerAfter"))
    ):
        raise ValueError(f"{path}: load supplier processor count differs from the recorded configuration")
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
    policy = report.get("connectionPolicy", "serial-tls-preconnect" if report.get("preconnectedTLS") else "fresh-pool")
    if policy == "carry-from-warmup":
        warm, reuse = report["warmup"], report["connectionReuse"]
        warm_totals = warm["routes"]["all"]
        warm_unreached = warm["schedulerUnreached"]
        if (
            any(warm[key] != report[key] for key in ("pid", "target", "generation", "fixtureSha256"))
            or (warm["requestedRate"], warm["seconds"], warm["expected"]) != (2000, 30, 60000)
            or not 0 <= warm_unreached <= 60000
            or warm_totals["sent"] + warm_totals["dropped"] + warm_unreached != 60000
            or any(warm_totals[key] != sum(warm["routes"][name][key] for name in ROUTE_WEIGHTS)
                   for key in ("sent", "dropped", "ok"))
            or not 0 <= warm_totals["ok"] <= warm_totals["sent"]
            or warm_totals["sent"] - warm_totals["ok"] != sum(warm_totals["errors"].values())
            or not 0 <= reuse["validatedOnRetained"] <= reuse["attemptedOnRetained"] <= reuse["retainedAfterWarmup"] <= 256
            or not reuse["validatedOnRetained"] <= reuse["requestsValidatedOnRetained"] <= totals["ok"]
            or not reuse["requestsValidatedOnRetained"] <= reuse["requestsAttemptedOnRetained"] <= totals["sent"]
            or not reuse["validatedOnRetained"]
            or not clock(warm["measurementStartedAt"]) < clock(warm["measurementCompletedAt"]) <= clock(report["measurementStartedAt"])
        ):
            raise ValueError(f"{path}: reused warmup evidence is missing or inconsistent")
        if not warm_unreached and any(
            warm["routes"][name]["sent"] + warm["routes"][name]["dropped"] != 60000 * weight // 100
            for name, weight in ROUTE_WEIGHTS.items()
        ):
            raise ValueError(f"{path}: warmup request mix differs from the frozen protocol")
    elif policy not in ("serial-tls-preconnect", "fresh-pool"):
        raise ValueError(f"{path}: unknown connection policy")
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
        "connectionPolicy": policy,
    }
    if policy == "carry-from-warmup":
        out["connectionReuse"] = reuse
        out["warmup"] = {"correct": warm_totals["ok"], "dropped": warm_totals["dropped"], "unreached": warm_unreached,
                         "errors": warm_totals["sent"] - warm_totals["ok"]}
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


def clock(value):
    # Python 3.9 requires either no fractional seconds or 3/6 digits.
    whole, separator, fraction = value[:-1].partition(".")
    if value[-1:] != "Z":
        raise ValueError(f"expected an ISO UTC timestamp: {value}")
    return datetime.fromisoformat(whole + ("." + fraction[:6].ljust(6, "0") if separator else "") + "+00:00")


def owner_finish(timestamp):
    # The native owner records floor-to-second timestamps unless the coordinator has a finer clock.
    finish = clock(timestamp)
    if "." not in timestamp:
        return finish + timedelta(seconds=1) - datetime.resolution
    return finish


def digest(path):
    with path.open("rb") as source:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
        return checksum.hexdigest()


def sealed_inputs(directory):
    return {key: digest(directory / name) for key, name in (
        ("archiveSha256", "fsusblog-v2.tar.gz"), ("payloadManifestSha256", "payload.sha256"),
        ("wireSha256", "wire.schema.json"), ("toolSha256", "load"),
    )}


def private_origin(value, scheme):
    try:
        origin = urlsplit(value)
        address = ip_address(origin.hostname)
        port = origin.port
    except (ValueError, TypeError):
        return False
    host = f"[{origin.hostname}]" if address.version == 6 else origin.hostname
    ranges = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
    return (bool(port) and "%" not in host and value == f"{scheme}://{host}:{port}"
            and any(address in ip_network(network) for network in ranges))


def private_stage(directory, topology, rate, receipt, binding, previous, finished):
    path = directory / f"{topology}-{rate}.json"
    raw = path.read_bytes()
    if (receipt["rate"] != rate or type(receipt["exitCode"]) is not int or receipt["exitCode"] != 0
            or hashlib.sha256(raw).hexdigest() != receipt["reportSha256"]):
        raise ValueError(f"{path}: private stage receipt differs from the raw result")
    report = json.loads(raw)
    if (
        any(report[key] != binding[key] for key in ("target", "generation", "fixtureSha256"))
        or report["targetScope"] != "explicit-private-literal"
        or report["connectionPolicy"] != "carry-from-warmup"
        or type(report["pid"]) is not int or report["pid"] < 1 or report["pid"] != receipt["supplierPid"]
        or report["tlsVersion"] not in (("TLS 1.2", "TLS 1.3") if topology == "proxy" else ("",))
        or not report["supplyBySecond"]
        or any(type(report[key]["runtimeMaxProcs"]) is not int or report[key]["runtimeMaxProcs"] < 1
               for key in ("producerBefore", "producerAfter"))
    ):
        raise ValueError(f"{path}: private supplier scope, process or transport differs")
    for window, count, requested_rate in ((report, SECONDS, rate), (report["warmup"], 30, 2000)):
        buckets = window["supplyBySecond"]
        if len(buckets) < count or any(
            row["second"] != second or row["planned"] != (requested_rate if second < count else 0)
            or not 0 <= row["observedOutstandingPeak"] <= 256
            for second, row in enumerate(buckets)
        ):
            raise ValueError(f"{path}: private stage producer timeline differs from the frozen schedule")
    warm = report["warmup"]
    accepted, collected = (clock(receipt[key]) for key in ("acceptedAt", "collectedAt"))
    launched, start, end, emitted = (clock(report[key]) for key in
                                    ("startedAt", "measurementStartedAt", "measurementCompletedAt", "finishedAt"))
    warm_start, warm_end = (clock(warm[key]) for key in ("measurementStartedAt", "measurementCompletedAt"))
    if not previous <= accepted <= launched <= warm_start < warm_end <= start < end <= emitted <= collected <= finished:
        raise ValueError(f"{path}: private stage lies outside its current owner interval")
    for window, nominal, requested_rate, first, last in (
        (warm, 30, 2000, warm_start, warm_end), (report, SECONDS, rate, start, end),
    ):
        elapsed = window["measurementElapsedSeconds"]
        if (
            type(elapsed) not in (int, float)
            or not nominal - 1 / requested_rate <= elapsed <= nominal + 2
            or abs((last - first).total_seconds() - elapsed) > 0.25
        ):
            raise ValueError(f"{path}: private stage duration differs from the frozen schedule")
    return report, collected


def private_matrix(directory, topology, environment, outcome, inputs):
    binding = json.loads((directory / "private-supplier.json").read_text())
    owner_path, release_path = directory / "owner.txt", directory / "release-input.json"
    owner = read_properties(owner_path)
    release = json.loads(release_path.read_text())
    attempt = {name: outcome[key] for name, key in (
        ("runId", "run_id"), ("invocationId", "invocation_id"), ("attemptId", "attempt_id"),
    )}
    hosts = (binding["serverHostId"], binding["supplierHostId"])
    if (
        type(binding["version"]) is not int or binding["version"] != 1 or binding["topology"] != topology
        or any(binding[key] != value or not re.fullmatch(r"[0-9a-f]{32}", value) for key, value in attempt.items())
        or len(set(attempt.values())) != len(attempt)
        or any(owner[key] != outcome[key] for key in
               ("run_id", "invocation_id", "attempt_id", "owner_pid", "server_pid", "origin", "database", "target"))
        or owner["readiness"] != "204" or binding["ownerSha256"] != digest(owner_path)
        or binding["outcomeSha256"] != digest(directory / "outcome.txt")
        or not all(re.fullmatch(r"[0-9a-f]{64}", host) for host in hosts) or hosts[0] == hosts[1]
    ):
        raise ValueError(f"{directory}: private supplier run, host or owner differs")
    target = binding["target"]
    pids = [owner[key] for key in ("owner_pid", "server_pid", "postgres_pid")]
    if topology == "proxy":
        pids.append(owner["proxy_pid"])
    if (
        target != owner["target"] or not private_origin(target, "http" if topology == "direct" else "https")
        or not all(re.fullmatch(r"[1-9][0-9]*", pid) for pid in pids) or len(set(pids)) != len(pids)
        or topology == "direct" and (target != owner["origin"] or outcome["proxy_pid"] != "")
        or topology == "proxy" and (owner["proxy_pid"] != outcome["proxy_pid"]
                                    or not re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", owner["origin"]))
        or binding["caSha256"] != (digest(directory / "ca.pem") if topology == "proxy" else None)
    ):
        raise ValueError(f"{directory}: private target, TLS authority or process ownership differs")
    generation = binding["generation"]
    if (
        release["buildSource"] != "verified-release-archive" or release["fsusblogCommit"] != environment["commit"]
        or binding["releaseInputSha256"] != digest(release_path)
        or any(binding[key] != sha for key, sha in inputs.items())
        or any(release[key] != inputs[key] for key in ("archiveSha256", "payloadManifestSha256"))
        or binding["fixtureSha256"] != digest(directory / "fixture.json")
        or not re.fullmatch(r"[1-9][0-9]*", generation)
    ):
        raise ValueError(f"{directory}: private sealed inputs or generation differ")
    started, ready = clock(outcome["started_at"]), clock(owner["ready_at"])
    finished = owner_finish(outcome["finished_at"])
    receipts = binding["stages"]
    if not started <= ready < finished <= datetime.now(timezone.utc) or len(receipts) != len(RATES):
        raise ValueError(f"{directory}: private run interval or stage count differs")
    reports = []
    previous = ready
    for rate, receipt in zip(RATES, receipts):
        report, previous = private_stage(directory, topology, rate, receipt, binding, previous, finished)
        if reports and (clock(report["startedAt"]) - clock(reports[-1]["finishedAt"])).total_seconds() < 15:
            raise ValueError(f"{directory}: private stages lack the frozen 15-second cooldown")
        reports.append(report)
    return reports, {**attempt, **inputs, "target": target, "generation": generation,
                     "serverHostId": hosts[0], "supplierHostId": hosts[1]}


def matrix(directory, topology, inputs=None):
    outcome = read_properties(directory / "outcome.txt")
    environment = read_properties(directory / "environment.txt")
    if outcome.get("exit_code") != "0" or outcome.get("cleanup") != "yes" or outcome.get("last_stage") != "finished":
        raise ValueError(f"{directory}: runner failed or cleanup is incomplete")
    if (directory / "source-status.txt").read_text():
        raise ValueError(f"{directory}: requires a clean candidate")
    p95_limit, p99_limit = (25, 75) if topology == "direct" else (40, 100)
    supplier_procs = environment.get("supplier_gomaxprocs", "runtime-default")
    binding = None
    if inputs is not None:
        try:
            reports, binding = private_matrix(directory, topology, environment, outcome, inputs)
        except (OSError, KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{directory}: private supplier admission failed: {error}") from error
    else:
        reports = [None] * len(RATES)
    stages = [stage(directory / f"{topology}-{rate}.json", rate, p95_limit, p99_limit, supplier_procs, report)
              for rate, report in zip(RATES, reports)]
    fixture = stages[0][0]
    if any(digest != fixture for digest, _ in stages):
        raise ValueError(f"{directory}: fixture differs between stages")
    if len({item["connectionPolicy"] for _, item in stages}) != 1:
        raise ValueError(f"{directory}: connection policy differs between stages")
    with (directory / "server-process.csv").open(newline="") as file:
        rss = max(int(row["rss_kib"]) for row in csv.DictReader(file)
                  if row["pid"] == outcome["server_pid"])
    return {
        "topology": topology,
        "commit": environment["commit"],
        "sourceSha256": environment["source_sha256"],
        "fixtureSha256": fixture,
        "connectionPolicy": stages[0][1]["connectionPolicy"],
        "supplierGomaxprocs": supplier_procs,
        "runId": outcome["run_id"],
        "startedAt": outcome["started_at"],
        "finishedAt": outcome["finished_at"],
        "serverRssPeakKiB": rss,
        "stages": [report for _, report in stages],
        **({"privateSupplierEvidence": binding} if binding is not None else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--direct", type=Path, action="append", default=[])
    parser.add_argument("--proxy", type=Path, action="append", default=[])
    parser.add_argument("--private-supplier-inputs", type=Path,
                        help="require private supplier admission against this trusted sealed-input directory")
    arguments = parser.parse_args()
    try:
        inputs = sealed_inputs(arguments.private_supplier_inputs) if arguments.private_supplier_inputs else None
        matrices = [matrix(path, kind, inputs) for kind, paths in (("direct", arguments.direct), ("proxy", arguments.proxy))
                    for path in paths]
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    if not matrices:
        parser.error("provide at least one completed direct or proxy matrix")
    coordinates = {(item["commit"], item["sourceSha256"], item["fixtureSha256"]) for item in matrices}
    ids = {item["runId"] for item in matrices}
    if len(coordinates) != 1 or len(ids) != len(matrices):
        parser.error("matrices must use the same source and fixture and have distinct owners")
    if len({item["supplierGomaxprocs"] for item in matrices}) != 1:
        parser.error("acceptance matrices must use the same load supplier processor configuration")
    for kind in ("direct", "proxy"):
        if len({item["connectionPolicy"] for item in matrices if item["topology"] == kind}) > 1:
            parser.error(f"{kind} acceptance matrices must use the same connection policy")
    if inputs is not None:
        bindings = [item["privateSupplierEvidence"] for item in matrices]
        if any(len({item[key] for item in bindings}) != len(bindings) for key in ("invocationId", "attemptId")):
            parser.error("private matrices must have distinct invocations and attempts")
        order = sorted((clock(item["startedAt"]), owner_finish(item["finishedAt"])) for item in matrices)
        if any(left[1] > right[0] for left, right in zip(order, order[1:])):
            parser.error("private matrices must have non-overlapping owner intervals")
        if len({(item["serverHostId"], item["supplierHostId"]) for item in bindings}) != 1:
            parser.error("private matrices must use the same server and supplier hosts")
    print(json.dumps(matrices, indent=2))


if __name__ == "__main__":
    main()
