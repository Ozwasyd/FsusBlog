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


def check(ok, message):
    if not ok:
        raise ValueError(message)


def read_properties(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)


def route_totals_match(by_route):
    totals = by_route["all"]
    return all(totals[k] == sum(by_route[route][k] for route in ROUTE_WEIGHTS) for k in ("sent", "dropped", "ok"))


def route_mix_matches(by_route, expected):
    return all(by_route[route]["sent"] + by_route[route]["dropped"] == expected * share // 100
               for route, share in ROUTE_WEIGHTS.items())


def stage(path, rate, p95_limit, p99_limit, supplier_procs, report=None, *, seconds=SECONDS):
    if report is None:
        report = json.loads(path.read_text())
    expected = rate * seconds
    by_route = report["routes"]
    totals = by_route["all"]
    check(report["preflight"] == "pass" and report["responses"] == 2402 and report["protocol"] == "HTTP/1.1"
          and (report["requestedRate"], report["seconds"], report["expected"]) == (rate, seconds, expected),
          f"{path}: workload or preflight differs from the frozen protocol")
    check(supplier_procs == "runtime-default" or (
        supplier_procs.isascii() and supplier_procs.isdecimal() and int(supplier_procs) >= 1
        and all(report.get(key, {}).get("runtimeMaxProcs") == int(supplier_procs)
                for key in ("producerBefore", "producerAfter"))),
        f"{path}: load supplier processor count differs from the recorded configuration")
    check(route_totals_match(by_route), f"{path}: route totals do not reconcile")
    unreached = expected - totals["sent"] - totals["dropped"]
    check(unreached >= 0 and report.get("schedulerUnreached", unreached) == unreached,
          f"{path}: scheduled counts do not reconcile")
    check(unreached or route_mix_matches(by_route, expected), f"{path}: request mix differs from the frozen protocol")
    request_errors = totals["sent"] - totals["ok"]
    check(request_errors == sum(totals["errors"].values()) and request_errors >= 0
          and totals["ok"] <= totals["httpStatus"].get("200", 0), f"{path}: failed attempts do not reconcile")
    supply = report.get("supplyBySecond")
    if supply:
        supply_totals = {"planned": expected, "schedulerAwake": expected - unreached,
                         "admitted": totals["sent"], "dropped": totals["dropped"],
                         "attemptFinished": totals["sent"], "correct": totals["ok"]}
        check(all(sum(row[key] for row in supply) == value for key, value in supply_totals.items()),
              f"{path}: producer timeline does not reconcile")
    policy = report.get("connectionPolicy", "serial-tls-preconnect" if report.get("preconnectedTLS") else "fresh-pool")
    if policy == "carry-from-warmup":
        warm, reuse = report["warmup"], report["connectionReuse"]
        warm_totals, warm_unreached = warm["routes"]["all"], warm["schedulerUnreached"]
        check(
            all(warm[key] == report[key] for key in ("pid", "target", "generation", "fixtureSha256"))
            and (warm["requestedRate"], warm["seconds"], warm["expected"]) == (2000, 30, 60000)
            and 0 <= warm_unreached <= 60000
            and warm_totals["sent"] + warm_totals["dropped"] + warm_unreached == 60000
            and route_totals_match(warm["routes"]) and 0 <= warm_totals["ok"] <= warm_totals["sent"]
            and warm_totals["sent"] - warm_totals["ok"] == sum(warm_totals["errors"].values())
            and 0 <= reuse["validatedOnRetained"] <= reuse["attemptedOnRetained"] <= reuse["retainedAfterWarmup"] <= 256
            and reuse["validatedOnRetained"] <= reuse["requestsValidatedOnRetained"] <= totals["ok"]
            and reuse["requestsValidatedOnRetained"] <= reuse["requestsAttemptedOnRetained"] <= totals["sent"]
            and reuse["validatedOnRetained"]
            and clock(warm["measurementStartedAt"]) < clock(warm["measurementCompletedAt"]) <= clock(report["measurementStartedAt"]),
            f"{path}: reused warmup evidence is missing or inconsistent")
        check(warm_unreached or route_mix_matches(warm["routes"], 60000),
              f"{path}: warmup request mix differs from the frozen protocol")
    else:
        check(policy in ("serial-tls-preconnect", "fresh-pool"), f"{path}: unknown connection policy")
    actual_rate = totals["ok"] / seconds
    failures = totals["dropped"] + request_errors + unreached
    per_route = {key: {k: by_route[key][k] for k in ("ok", "p95Ms", "p99Ms")} for key in ROUTE_WEIGHTS}
    out = {
        "plannedRate": rate, "correctPerSecond": actual_rate, "correct": totals["ok"],
        "errors": request_errors, "dropped": totals["dropped"], "unreached": unreached,
        "failurePercent": failures * 100 / expected, "p95Ms": totals["p95Ms"], "p99Ms": totals["p99Ms"],
        "routes": per_route, "connectionPolicy": policy,
    }
    if policy == "carry-from-warmup":
        out["connectionReuse"] = reuse
        out["warmup"] = {"correct": warm_totals["ok"], "dropped": warm_totals["dropped"], "unreached": warm_unreached,
                         "errors": warm_totals["sent"] - warm_totals["ok"]}
    if supply:
        out["dropSeconds"] = [row for row in supply if row["dropped"]]
    if rate == RATES[-1] and seconds == SECONDS:
        out["numericPeakPassed"] = (
            actual_rate > 10000 and failures * 1000 <= expected
            and all(0 < row["p95Ms"] <= p95_limit and 0 < row["p99Ms"] <= p99_limit
                    for row in (*per_route.values(), totals)))
    return report["fixtureSha256"], out


def clock(value):
    # Python 3.9 requires either no fractional seconds or 3/6 digits.
    whole, separator, fraction = value[:-1].partition(".")
    check(value[-1:] == "Z", f"expected an ISO UTC timestamp: {value}")
    return datetime.fromisoformat(whole + ("." + fraction[:6].ljust(6, "0") if separator else "") + "+00:00")


def owner_finish(timestamp):
    # The native owner records floor-to-second timestamps unless the coordinator has a finer clock.
    finish = clock(timestamp)
    return finish + timedelta(seconds=1) - datetime.resolution if "." not in timestamp else finish


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
        address, port = ip_address(origin.hostname), origin.port
    except (ValueError, TypeError):
        return False
    host = f"[{origin.hostname}]" if address.version == 6 else origin.hostname
    ranges = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
    # urlsplit lowercases the parsed hostname; the Go report retains the chosen IPv6 spelling.
    return (bool(port) and "%" not in host and origin.netloc.lower() == f"{host}:{port}"
            and value == f"{scheme}://{origin.netloc}"
            and any(address in ip_network(network) for network in ranges))


def private_stage(directory, topology, rate, receipt, binding, previous, finished):
    path = directory / f"{topology}-{rate}.json"
    raw = path.read_bytes()
    check(receipt["rate"] == rate and type(receipt["exitCode"]) is int and receipt["exitCode"] == 0
          and hashlib.sha256(raw).hexdigest() == receipt["reportSha256"],
          f"{path}: private stage receipt differs from the raw result")
    report = json.loads(raw)
    check(all(report[key] == binding[key] for key in ("target", "generation", "fixtureSha256"))
          and report["targetScope"] == "explicit-private-literal"
          and report["connectionPolicy"] == "carry-from-warmup"
          and type(report["pid"]) is int and report["pid"] >= 1 and report["pid"] == receipt["supplierPid"]
          and report["tlsVersion"] in (("TLS 1.2", "TLS 1.3") if topology == "proxy" else ("",))
          and report["supplyBySecond"]
          and all(type(report[key]["runtimeMaxProcs"]) is int and report[key]["runtimeMaxProcs"] >= 1
                  for key in ("producerBefore", "producerAfter")),
          f"{path}: private supplier scope, process or transport differs")
    for window, count, requested_rate in ((report, SECONDS, rate), (report["warmup"], 30, 2000)):
        buckets = window["supplyBySecond"]
        check(len(buckets) >= count and all(
            row["second"] == second and row["planned"] == (requested_rate if second < count else 0)
            and 0 <= row["observedOutstandingPeak"] <= 256
            for second, row in enumerate(buckets)),
            f"{path}: private stage producer timeline differs from the frozen schedule")
    warm = report["warmup"]
    accepted, collected = (clock(receipt[key]) for key in ("acceptedAt", "collectedAt"))
    launched, start, end, emitted = (clock(report[key]) for key in
                                     ("startedAt", "measurementStartedAt", "measurementCompletedAt", "finishedAt"))
    warm_start, warm_end = (clock(warm[key]) for key in ("measurementStartedAt", "measurementCompletedAt"))
    check(previous <= accepted <= launched <= warm_start < warm_end <= start < end <= emitted <= collected <= finished,
          f"{path}: private stage lies outside its current owner interval")
    for window, nominal, requested_rate, first, last in (
        (warm, 30, 2000, warm_start, warm_end), (report, SECONDS, rate, start, end),
    ):
        elapsed = window["measurementElapsedSeconds"]
        check(type(elapsed) in (int, float) and nominal - 1 / requested_rate <= elapsed <= nominal + 2
              and abs((last - first).total_seconds() - elapsed) <= 0.25,
              f"{path}: private stage duration differs from the frozen schedule")
    return report, collected


def private_matrix(directory, topology, environment, outcome, inputs):
    binding = json.loads((directory / "private-supplier.json").read_text())
    owner_path, release_path = directory / "owner.txt", directory / "release-input.json"
    owner, release = read_properties(owner_path), json.loads(release_path.read_text())
    attempt = {name: outcome[key] for name, key in (("runId", "run_id"), ("invocationId", "invocation_id"), ("attemptId", "attempt_id"))}
    hosts = (binding["serverHostId"], binding["supplierHostId"])
    check(type(binding["version"]) is int and binding["version"] == 1 and binding["topology"] == topology
          and all(binding[key] == value and re.fullmatch(r"[0-9a-f]{32}", value) for key, value in attempt.items())
          and len(set(attempt.values())) == len(attempt)
          and all(owner[key] == outcome[key] for key in ("run_id", "invocation_id", "attempt_id", "owner_pid", "server_pid", "origin", "database", "target"))
          and owner["readiness"] == "204" and binding["ownerSha256"] == digest(owner_path)
          and binding["outcomeSha256"] == digest(directory / "outcome.txt")
          and all(re.fullmatch(r"[0-9a-f]{64}", host) for host in hosts) and hosts[0] != hosts[1],
          f"{directory}: private supplier run, host or owner differs")
    target = binding["target"]
    pids = [owner[key] for key in ("owner_pid", "server_pid", "postgres_pid")] + ([owner["proxy_pid"]] if topology == "proxy" else [])
    check(target == owner["target"] and private_origin(target, "http" if topology == "direct" else "https")
          and all(re.fullmatch(r"[1-9][0-9]*", pid) for pid in pids) and len(set(pids)) == len(pids)
          and (target == owner["origin"] and outcome["proxy_pid"] == "" if topology == "direct"
               else owner["proxy_pid"] == outcome["proxy_pid"] and re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", owner["origin"]))
          and binding["caSha256"] == (digest(directory / "ca.pem") if topology == "proxy" else None),
          f"{directory}: private target, TLS authority or process ownership differs")
    generation = binding["generation"]
    check(release["buildSource"] == "verified-release-archive" and release["fsusblogCommit"] == environment["commit"]
          and binding["releaseInputSha256"] == digest(release_path)
          and all(binding[key] == sha for key, sha in inputs.items())
          and all(release[key] == inputs[key] for key in ("archiveSha256", "payloadManifestSha256"))
          and binding["fixtureSha256"] == digest(directory / "fixture.json") and re.fullmatch(r"[1-9][0-9]*", generation),
          f"{directory}: private sealed inputs or generation differ")
    started, ready, finished = clock(outcome["started_at"]), clock(owner["ready_at"]), owner_finish(outcome["finished_at"])
    receipts = binding["stages"]
    check(started <= ready < finished <= datetime.now(timezone.utc) and len(receipts) == len(RATES),
          f"{directory}: private run interval or stage count differs")
    reports, previous = [], ready
    for rate, receipt in zip(RATES, receipts):
        report, previous = private_stage(directory, topology, rate, receipt, binding, previous, finished)
        check(not reports or (clock(report["startedAt"]) - clock(reports[-1]["finishedAt"])).total_seconds() >= 15,
              f"{directory}: private stages lack the frozen 15-second cooldown")
        reports.append(report)
    return reports, {**attempt, **inputs, "target": target, "generation": generation,
                     "serverHostId": hosts[0], "supplierHostId": hosts[1]}


def matrix(directory, topology, inputs=None):
    outcome, environment = read_properties(directory / "outcome.txt"), read_properties(directory / "environment.txt")
    check(outcome.get("exit_code") == "0" and outcome.get("cleanup") == "yes" and outcome.get("last_stage") == "finished",
          f"{directory}: runner failed or cleanup is incomplete")
    check(not (directory / "source-status.txt").read_text(), f"{directory}: requires a clean candidate")
    p95_limit, p99_limit = (25, 75) if topology == "direct" else (40, 100)
    supplier_procs = environment.get("supplier_gomaxprocs", "runtime-default")
    binding, reports = None, [None] * len(RATES)
    if inputs is not None:
        try:
            reports, binding = private_matrix(directory, topology, environment, outcome, inputs)
        except (OSError, KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{directory}: private supplier admission failed: {error}") from error
    stages = [stage(directory / f"{topology}-{rate}.json", rate, p95_limit, p99_limit, supplier_procs, report)
              for rate, report in zip(RATES, reports)]
    fixture = stages[0][0]
    check(all(item == fixture for item, _ in stages), f"{directory}: fixture differs between stages")
    check(len({item["connectionPolicy"] for _, item in stages}) == 1, f"{directory}: connection policy differs between stages")
    with (directory / "server-process.csv").open(newline="") as file:
        rss = max(int(row["rss_kib"]) for row in csv.DictReader(file) if row["pid"] == outcome["server_pid"])
    return {
        "topology": topology, "commit": environment["commit"], "sourceSha256": environment["source_sha256"],
        "fixtureSha256": fixture, "connectionPolicy": stages[0][1]["connectionPolicy"],
        "supplierGomaxprocs": supplier_procs, "runId": outcome["run_id"],
        "startedAt": outcome["started_at"], "finishedAt": outcome["finished_at"],
        "serverRssPeakKiB": rss, "stages": [report for _, report in stages],
        **({"privateSupplierEvidence": binding} if binding is not None else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--direct", type=Path, action="append", default=[])
    parser.add_argument("--proxy", type=Path, action="append", default=[])
    parser.add_argument("--private-supplier-inputs", type=Path,
                        help="require private supplier admission against this trusted sealed-input directory")
    parser.add_argument("--require-peak-quorum", action="store_true",
                        help="exit 1 unless two matrices of each topology pass the frozen short peak numbers")
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
    if arguments.require_peak_quorum and not peak_quorum(matrices):
        parser.exit(1, "The short numeric gate requires two passing direct and two passing TLS matrices.\n")


def peak_quorum(matrices):
    return all(sum(item["topology"] == kind and item["stages"][-1]["numericPeakPassed"] is True
                   for item in matrices) >= 2 for kind in ("direct", "proxy"))


if __name__ == "__main__":
    main()
