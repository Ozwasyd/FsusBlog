#!/usr/bin/env python3
"""Summarize marked runtime evidence for the frozen public-read workload."""

import argparse
import csv
from datetime import datetime, timedelta
import json
from math import ceil
from pathlib import Path
import re
from statistics import median
import sys


ROUTES = {
    "home-html": "homeHtml",
    "detail-html": "detailHtml",
    "home-aeds": "homeAeds",
    "detail-aeds": "detailAeds",
}


def timestamp(text):
    # macOS may ship Python 3.9. Normalize arbitrary .NET/Go fraction lengths
    # to six digits before calling its stricter datetime parser.
    text = re.sub(r"\.(\d+)(?=Z|[+-])", lambda m: "." + m[1][:6].ljust(6, "0"), text)
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def percentile(samples, p):
    return sorted(samples)[ceil(p * len(samples)) - 1] if samples else None


def commands(start, end, metric):
    return {category: value - start[metric][category] for category, value in end[metric].items()}


def summarize(rows, load, rss, pid):
    if not rows or any(row["pid"] != pid for row in rows):
        raise ValueError("Runtime samples require the PID of the run-owned Kestrel.")
    controls = ["positive-before", "positive-after", "measure-before", "measure-after"]
    marks = [row for row in rows if row["mark"] in controls]
    if [row["mark"] for row in marks] != controls:
        raise ValueError("Required runtime boundaries are missing or out of order.")
    control_start, control_end, start, end = marks
    start_at, end_at = timestamp(start["utc"]), timestamp(end["utc"])
    measured_at = timestamp(load["measurementStartedAt"])
    duration = load["seconds"]
    measured_end = measured_at + timedelta(seconds=duration)
    drained_at = timestamp(load["measurementCompletedAt"])
    if not start_at <= measured_at <= measured_end <= drained_at <= end_at:
        raise ValueError("The marked runtime interval does not enclose the load interval.")

    gc_pauses = [
        pause["Milliseconds"]
        for row in rows
        for pause in row["gcPauses"]
        if start_at <= timestamp(pause["StartUtc"]) <= timestamp(pause["EndUtc"]) <= end_at
    ]
    series = [row for row in rows if start_at <= timestamp(row["utc"]) <= end_at]
    all_routes = load["routes"]["all"]
    correct = all_routes["ok"]
    allocated = end["managedAllocatedBytes"] - start["managedAllocatedBytes"]
    query_counts = commands(start, end, "dbCommandStarts")
    opening_counts = commands(start, end, "dbPhysicalOpenStarts")
    completed = commands(start, end, "requestCompleted")
    success = commands(start, end, "requestStatus200")
    control_commands = commands(control_start, control_end, "dbCommandStarts")["comments"]
    control_requests = commands(control_start, control_end, "requestStatus200")["comments"]
    runtime_pause = end["gcTotalPauseMs"] - start["gcTotalPauseMs"]
    traced_pause = sum(gc_pauses)
    trailing = next((row for row in rows if timestamp(row["utc"]) > end_at), None)
    unmatched = (trailing or end)["gcUnmatched"] - start["gcUnmatched"]
    guard_before = (measured_at - start_at).total_seconds()
    guard_after = (end_at - drained_at).total_seconds()
    observer_samples = end["observerRequestSamples"] - start["observerRequestSamples"]
    observer_ticks = end["observerRequestMeasuredTicks"] - start["observerRequestMeasuredTicks"]

    errors = []
    if trailing is None:
        errors.append("No post-measurement sample was available to collect late GC events.")
    if control_commands <= 0 or control_requests != 1:
        errors.append("No instrumented PostgreSQL command found under the positive HTTP comments control.")
    startup_opens = sum(rows[0]["dbPhysicalOpenStarts"].values())
    initial_control_opens = sum(control_start["dbPhysicalOpenStarts"].values())
    if max(startup_opens, initial_control_opens) <= 0:
        errors.append("No physical PostgreSQL open was captured from startup.")
    if query_counts["publication"] <= 0:
        errors.append("No PostgreSQL commands observed under periodic projection work.")
    if query_counts["background"] + query_counts["lease"] <= 0:
        errors.append("No concurrently measured PostgreSQL background command observed.")
    if query_counts["background"] != 0:
        errors.append("An unclassified Npgsql command occurred during hot measurement.")
    if query_counts["comments"] != 0 or query_counts["otherHttp"] != 0:
        errors.append("Unexpected PostgreSQL request activity occurred during hot measurement.")
    for route, category in ROUTES.items():
        stats = load["routes"][route]
        if completed[category] != stats["sent"] or success[category] != stats["ok"]:
            errors.append(f"Server and load client totals disagree on {route}.")
        if query_counts[category] != 0 or opening_counts[category] != 0:
            errors.append(f"PostgreSQL activity occurred under {route}.")
    if end["projectionBuilds"] != start["projectionBuilds"] or end["coldRenders"] != start["coldRenders"]:
        errors.append("A projection build or cold detail render changed the hot interval.")
    if end["coldPendingPeak"] or end["coldActivePeak"]:
        errors.append("Detail cache work was queued during the hot interval.")
    if (duration == 900 and not gc_pauses) or unmatched or abs(runtime_pause - traced_pause) > max(10, 0.2 * runtime_pause):
        errors.append("GC pause events did not reconcile to the built-in total pause time.")
    if guard_before > 1 or guard_after > 3:
        errors.append("Runtime and client measurement bounds have excessive idle margins.")

    rss_values = [(timestamp(row["utc"]), int(row["rss_kib"])) for row in rss if int(row["pid"]) == pid]
    rss_peak = max((kb for stamp, kb in rss_values if measured_at <= stamp <= measured_end), default=None)
    mid_rss = [kb for stamp, kb in rss_values
               if measured_at + timedelta(minutes=5) < stamp <= measured_at + timedelta(minutes=10)]
    end_rss = [kb for stamp, kb in rss_values
               if measured_at + timedelta(minutes=10) < stamp <= measured_end]
    rss_growth = (median(end_rss) / median(mid_rss) - 1.0) if len(mid_rss) >= 50 and len(end_rss) >= 50 else None
    queue_growth = None
    stability = None
    if duration == 900:
        mid_queue = [row["threadPoolPending"] for row in series
                     if measured_at + timedelta(minutes=5) < timestamp(row["utc"]) <= measured_at + timedelta(minutes=10)]
        final_queue = [row["threadPoolPending"] for row in series
                       if measured_at + timedelta(minutes=10) < timestamp(row["utc"]) <= measured_end]
        if len(mid_queue) >= 50 and len(final_queue) >= 50:
            queue_growth = median(final_queue) - median(mid_queue)
        stability = (
            rss_peak is not None
            and rss_peak <= 1.5 * 1024 * 1024
            and rss_growth is not None and rss_growth <= 0.1
        )
        if not stability:
            errors.append("15-minute RSS ceiling, growth, or sample completeness did not pass.")
        if queue_growth is None or queue_growth > 0:
            errors.append("15-minute thread pool samples are incomplete or their final five-minute median grew.")

    return {
        "runtimeStart": start["utc"],
        "loadStart": load["measurementStartedAt"],
        "runtimeEnd": end["utc"],
        "boundsIdleSeconds": {"before": guard_before, "after": guard_after},
        "durationSeconds": duration,
        "serverPid": pid,
        "runtimeSamples": len(series),
        "load": {"planned": load["expected"], "sent": all_routes["sent"], "correct": correct,
                 "schedulerDropped": all_routes["dropped"], "clientMeasurement": load["measurement"]},
        "dbCommandStarts": query_counts,
        "dbPhysicalOpenStarts": opening_counts,
        "positiveControl": {"commentsSuccessfulRequests": control_requests, "commentsDatabaseCommands": control_commands,
                            "startupPhysicalOpens": max(startup_opens, initial_control_opens)},
        "serverRequestsCompleted": completed,
        "serverStatus200": success,
        "managedAllocatedBytes": allocated,
        "managedAllocatedBytesPerCorrectResponse": allocated / correct if correct else None,
        "observerMiddlewareSamples": observer_samples,
        "observerMiddlewareMeasuredNsPerSample": 1e9 * observer_ticks / end["clockTicksPerSecond"] / observer_samples
        if observer_samples else None,
        "gcCollectionCounts": [b - a for a, b in zip(start["gcCollectionCounts"], end["gcCollectionCounts"])],
        "gcPauseCount": len(gc_pauses),
        "gcPauseTotalMs": runtime_pause,
        "gcTracePauseTotalMs": traced_pause,
        "gcUnmatchedEvents": unmatched,
        "gcPauseP50Ms": percentile(gc_pauses, 0.50),
        "gcPauseP95Ms": percentile(gc_pauses, 0.95),
        "gcPauseP99Ms": percentile(gc_pauses, 0.99),
        "gcHeapPeakBytes": max(row["gcHeapBytes"] for row in series),
        "gcCommittedPeakBytes": max(row["gcCommittedBytes"] for row in series),
        "threadPoolPendingSampleMax": max(row["threadPoolPending"] for row in series),
        "threadPoolPendingMedianGrowth": queue_growth,
        "coldPendingPeak": end["coldPendingPeak"],
        "coldActivePeak": end["coldActivePeak"],
        "coldRenders": end["coldRenders"] - start["coldRenders"],
        "publicationRefreshes": end["refreshes"] - start["refreshes"],
        "publicationBuilds": end["projectionBuilds"] - start["projectionBuilds"],
        "serverRssPeakKiB": rss_peak,
        "serverRssMinute6To10MedianKiB": median(mid_rss) if mid_rss else None,
        "serverRssLast5MinutesMedianKiB": median(end_rss) if end_rss else None,
        "serverRssGrowthFraction": rss_growth,
        "serverRssStabilityPassed": stability,
        "result": "verified" if not errors else "incomplete",
        "errors": errors,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("load", type=Path)
    parser.add_argument("rss", type=Path)
    parser.add_argument("pid", type=int)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    try:
        # An active recorder may be flushing the next sample at EOF.
        lines = args.runtime.read_bytes().split(b"\n")[:-1]
        rows = [json.loads(line) for line in lines]
        rss_lines = args.rss.read_text().split("\n")[:-1]
        report = summarize(rows, json.loads(args.load.read_text()), csv.DictReader(rss_lines), args.pid)
        with args.out.open("x") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")
        if report["errors"]:
            print("\n".join(report["errors"]), file=sys.stderr)
            return 1
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
