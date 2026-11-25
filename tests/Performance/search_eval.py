#!/usr/bin/env python3
"""Reproducible public-search relevance, latency, memory, and energy evaluation harness (#44).

Design principles:
- Select implementations by relevance and latency gates FIRST, then compare energy among
  implementations that qualify.
- Keep human/graded relevance evaluation strictly separate from optimized-vs-exhaustive
  equivalence checks.
- Report missing energy instrumentation explicitly as unavailable (None), NEVER as zero.
- Distinguish CPU-package vs whole-system measured energy from parameterized network estimates.
- Support paired repeated runs with warm-up, alternating order, idle power baseline, and
  measurement-overhead accounting.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Mapping, Sequence

ROOT = Path(__file__).resolve().parent.parent.parent
EVAL_DIR = Path(__file__).resolve().parent / "SearchEval"
DEFAULT_CONFIG = EVAL_DIR / "config.v1.json"
DEFAULT_CORPUS = EVAL_DIR / "corpus.v1.json"
DEFAULT_QUERIES = EVAL_DIR / "queries.v1.json"
PROTOCOL_CSPROJ = ROOT / "tests/Protocol/FsusBlog.V2.ProtocolTests.csproj"
LOCAL_SCRIPT = Path(__file__).resolve().parent / "search-eval-local.mjs"


# ---------------------------------------------------------------------------
# Relevance metrics (graded IR evaluation — separate from equivalence checks)
# ---------------------------------------------------------------------------

def dcg_at_k(relevances: Sequence[int], k: int = 10) -> float:
    total = 0.0
    for rank, rel in enumerate(relevances[:k], start=1):
        if rel > 0:
            total += (2**rel - 1) / math.log2(rank + 1)
    return total


def ndcg_at_k(ranked_ids: Sequence[int], judgments: Mapping[int, int], k: int = 10) -> float:
    ideal = sorted((g for g in judgments.values() if g > 0), reverse=True)
    if not ideal:
        return 1.0 if not ranked_ids else 0.0
    idcg = dcg_at_k(ideal, k)
    if idcg == 0.0:
        return 0.0
    seen: set[int] = set()
    rels: list[int] = []
    for aid in ranked_ids[:k]:
        if aid in seen:
            rels.append(0)
            continue
        seen.add(aid)
        rels.append(int(judgments.get(aid, 0)))
    return dcg_at_k(rels, k) / idcg


def mrr_at_k(ranked_ids: Sequence[int], judgments: Mapping[int, int], k: int = 10) -> float:
    for rank, aid in enumerate(ranked_ids[:k], start=1):
        if judgments.get(aid, 0) > 0:
            return 1.0 / rank
    return 0.0


def target_success_at_k(ranked_ids: Sequence[int], target_ids: Sequence[int], k: int = 3) -> float:
    if not target_ids:
        return 1.0 if not ranked_ids else 0.0
    top = set(ranked_ids[:k])
    return 1.0 if any(tid in top for tid in target_ids) else 0.0


def recall_at_k(ranked_ids: Sequence[int], judgments: Mapping[int, int], k: int = 10) -> float:
    relevant = {aid for aid, grade in judgments.items() if grade > 0}
    if not relevant:
        return 1.0 if not ranked_ids else 0.0
    found = set(ranked_ids[:k]) & relevant
    return len(found) / len(relevant)


def _compute_bucket(queries: Sequence[dict[str, Any]], results_by_id: Mapping[str, dict[str, Any]]) -> dict[str, Any]:
    positive_ndcg: list[float] = []
    positive_mrr: list[float] = []
    positive_s3: list[float] = []
    positive_r10: list[float] = []
    empty_total = 0
    empty_false_positives = 0
    failed = 0
    rejected = 0
    failures_sample: list[dict[str, Any]] = []

    for q in queries:
        qid = q["id"]
        res = results_by_id.get(qid, {"ok": False, "articleIds": [], "total": 0})
        if not res.get("ok", False):
            if res.get("rejected"):
                rejected += 1
            else:
                failed += 1
        ranked = [int(x) for x in res.get("articleIds", [])]
        judgments = {int(k): int(v) for k, v in q["judgments"].items()}
        targets = [int(x) for x in q["targetArticleIds"]]

        if q["expectedEmpty"]:
            empty_total += 1
            # For an overlong rejected query, returning an explicit rejection is NOT a false-positive hit,
            # whereas returning matching articles IS a false positive.
            if ranked or int(res.get("total", 0)) > 0:
                empty_false_positives += 1
                if len(failures_sample) < 25:
                    failures_sample.append({
                        "id": qid, "category": q["category"], "query": q["query"],
                        "reason": "false_positive_on_expected_empty", "gotIds": ranked[:5],
                    })
        else:
            n10 = ndcg_at_k(ranked, judgments, 10)
            m10 = mrr_at_k(ranked, judgments, 10)
            s3 = target_success_at_k(ranked, targets, 3)
            r10 = recall_at_k(ranked, judgments, 10)
            positive_ndcg.append(n10)
            positive_mrr.append(m10)
            positive_s3.append(s3)
            positive_r10.append(r10)
            if s3 < 1.0 and len(failures_sample) < 25:
                failures_sample.append({
                    "id": qid, "category": q["category"], "query": q["query"],
                    "reason": "target_not_in_top3", "targets": targets, "gotIds": ranked[:5],
                })

    def avg(xs: Sequence[float]) -> float | None:
        return (sum(xs) / len(xs)) if xs else None

    return {
        "queryCount": len(queries),
        "positiveQueryCount": len(positive_ndcg),
        "expectedEmptyQueryCount": empty_total,
        "ndcgAt10": avg(positive_ndcg),
        "mrrAt10": avg(positive_mrr),
        "targetSuccessAt3": avg(positive_s3),
        "recallAt10": avg(positive_r10),
        "noMatchFalsePositives": empty_false_positives,
        "noMatchFalsePositiveRate": (empty_false_positives / empty_total) if empty_total else None,
        "failedRequests": failed,
        "rejectedRequests": rejected,
        "failureSamples": failures_sample,
    }


def compute_relevance_report(
    queries: Sequence[dict[str, Any]],
    results: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Compute graded relevance separately for tuning, holdout, and each query category."""
    by_id = {r["id"]: r for r in results}
    tuning = [q for q in queries if q["split"] == "tuning"]
    holdout = [q for q in queries if q["split"] == "holdout"]
    categories = sorted({q["category"] for q in queries})
    by_category: dict[str, Any] = {}
    for cat in categories:
        cat_qs = [q for q in queries if q["category"] == cat]
        by_category[cat] = {
            "all": _compute_bucket(cat_qs, by_id),
            "tuning": _compute_bucket([q for q in cat_qs if q["split"] == "tuning"], by_id),
            "holdout": _compute_bucket([q for q in cat_qs if q["split"] == "holdout"], by_id),
        }
    return {
        "overall": _compute_bucket(queries, by_id),
        "tuning": _compute_bucket(tuning, by_id),
        "holdout": _compute_bucket(holdout, by_id),
        "byCategory": by_category,
    }


# ---------------------------------------------------------------------------
# Optimized-vs-Exhaustive / Cross-Path Equivalence (strictly separate from IR)
# ---------------------------------------------------------------------------

def compute_equivalence_check(
    reference_results: Sequence[dict[str, Any]],
    candidate_results: Sequence[dict[str, Any]],
    top_k: int = 10,
) -> dict[str, Any]:
    """Compare two search implementations for exact ordered-result equivalence."""
    ref_map = {r["id"]: r for r in reference_results}
    cand_map = {r["id"]: r for r in candidate_results}
    common_ids = sorted(set(ref_map) & set(cand_map))
    exact_matches = 0
    mismatches: list[dict[str, Any]] = []
    for qid in common_ids:
        ref_ids = [int(x) for x in ref_map[qid].get("articleIds", [])[:top_k]]
        cand_ids = [int(x) for x in cand_map[qid].get("articleIds", [])[:top_k]]
        if ref_ids == cand_ids and bool(ref_map[qid].get("ok")) == bool(cand_map[qid].get("ok")):
            exact_matches += 1
        else:
            if len(mismatches) < 25:
                mismatches.append({
                    "id": qid,
                    "referenceIds": ref_ids,
                    "candidateIds": cand_ids,
                    "referenceOk": bool(ref_map[qid].get("ok")),
                    "candidateOk": bool(cand_map[qid].get("ok")),
                })
    total = len(common_ids)
    return {
        "topK": top_k,
        "comparedQueries": total,
        "exactOrderMatches": exact_matches,
        "agreementRate": (exact_matches / total) if total else None,
        "mismatchCount": total - exact_matches,
        "mismatchSamples": mismatches,
    }


# ---------------------------------------------------------------------------
# Hardware Energy Probe (never reports missing instrumentation as zero)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RaplDomain:
    name: str
    energy_path: Path
    max_range_uj: int


@dataclass(frozen=True)
class EnergySample:
    available: bool
    scope: str  # "cpu_package" | "whole_system" | "unavailable"
    joules: float | None
    duration_seconds: float
    unavailable_reason: str | None = None
    backend: str | None = None


class EnergyProbe:
    """Reads hardware energy counters when accessible; otherwise explicitly reports unavailable."""

    def __init__(self, rapl_root: Path | None = None, system_name: str | None = None) -> None:
        self._system = system_name or platform.system()
        self._rapl_root = rapl_root or Path("/sys/class/powercap")
        self._domains: list[RaplDomain] = []
        self._unavailable_reason: str | None = None
        self._discover()

    def _discover(self) -> None:
        if self._system != "Linux":
            self._unavailable_reason = (
                f"Hardware CPU-package/whole-system energy counter is unavailable without privileged "
                f"instrumentation on {self._system}."
            )
            return
        if not self._rapl_root.exists():
            self._unavailable_reason = "Linux powercap RAPL sysfs directory is not present."
            return
        domains: list[RaplDomain] = []
        for entry in sorted(self._rapl_root.glob("intel-rapl:*")):
            # Package-level domains have exactly one colon (e.g. intel-rapl:0); skip subzones (intel-rapl:0:0)
            if entry.name.count(":") != 1:
                continue
            energy_file = entry / "energy_uj"
            max_file = entry / "max_energy_range_uj"
            if not energy_file.exists():
                continue
            try:
                _ = int(energy_file.read_text(encoding="utf-8").strip())
                max_val = int(max_file.read_text(encoding="utf-8").strip()) if max_file.exists() else 0
                name_file = entry / "name"
                name = name_file.read_text(encoding="utf-8").strip() if name_file.exists() else entry.name
                domains.append(RaplDomain(name=name, energy_path=energy_file, max_range_uj=max_val))
            except OSError:
                continue
        if domains:
            self._domains = domains
        else:
            self._unavailable_reason = (
                "No readable Linux RAPL package energy_uj counters found (requires powercap support "
                "and read permission)."
            )

    @property
    def available(self) -> bool:
        return bool(self._domains)

    @property
    def scope(self) -> str:
        return "cpu_package" if self._domains else "unavailable"

    @property
    def unavailable_reason(self) -> str | None:
        return self._unavailable_reason

    def read_uj(self) -> list[int] | None:
        if not self._domains:
            return None
        values: list[int] = []
        for domain in self._domains:
            values.append(int(domain.energy_path.read_text(encoding="utf-8").strip()))
        return values

    def delta_joules(self, start_uj: Sequence[int], end_uj: Sequence[int]) -> float:
        total_uj = 0
        for domain, s, e in zip(self._domains, start_uj, end_uj):
            if e >= s:
                total_uj += e - s
            elif domain.max_range_uj > 0:
                total_uj += (domain.max_range_uj - s) + e
            else:
                raise ValueError(f"RAPL counter wrapped for {domain.name} without max_energy_range_uj")
        return total_uj / 1_000_000.0

    def measure(self, fn: Callable[[], Any]) -> tuple[Any, EnergySample]:
        start_uj = self.read_uj()
        t0 = time.perf_counter()
        result = fn()
        duration = time.perf_counter() - t0
        end_uj = self.read_uj()
        if start_uj is None or end_uj is None:
            return result, EnergySample(
                available=False,
                scope="unavailable",
                joules=None,
                duration_seconds=duration,
                unavailable_reason=self._unavailable_reason,
                backend=None,
            )
        return result, EnergySample(
            available=True,
            scope="cpu_package",
            joules=self.delta_joules(start_uj, end_uj),
            duration_seconds=duration,
            unavailable_reason=None,
            backend="linux-powercap-rapl",
        )


def estimate_network_energy_joules(transferred_bytes: int, joules_per_mb: float) -> dict[str, Any]:
    return {
        "isEstimate": True,
        "transferredBytes": int(transferred_bytes),
        "joulesPerMegabyteModel": joules_per_mb,
        "estimatedJoules": (transferred_bytes / (1024.0 * 1024.0)) * joules_per_mb,
    }


def evaluate_provisional_gates(
    relevance_holdout: Mapping[str, Any],
    p95_latency_ms: float,
    offered_requests: int,
    failed_requests: int,
    rejected_requests: int,
    gates: Mapping[str, Any],
) -> dict[str, Any]:
    """Select implementations by relevance, latency, and reliability gates BEFORE energy comparison."""
    reasons: list[str] = []
    ndcg = relevance_holdout.get("ndcgAt10")
    s3 = relevance_holdout.get("targetSuccessAt3")
    fpr = relevance_holdout.get("noMatchFalsePositiveRate")

    if ndcg is None or ndcg < gates["heldOutNdcgAt10Min"]:
        reasons.append(f"holdout_ndcg@10={ndcg} < {gates['heldOutNdcgAt10Min']}")
    if s3 is None or s3 < gates["targetSuccessAt3Min"]:
        reasons.append(f"holdout_success@3={s3} < {gates['targetSuccessAt3Min']}")
    if fpr is not None and fpr > gates["noMatchFalsePositiveRateMax"]:
        reasons.append(f"holdout_no_match_fpr={fpr} > {gates['noMatchFalsePositiveRateMax']}")
    if p95_latency_ms > gates["serverLatencyP95MsMax"]:
        reasons.append(f"p95_latency_ms={p95_latency_ms:.3f} > {gates['serverLatencyP95MsMax']}")
    bad_rate = ((failed_requests + rejected_requests) / offered_requests) if offered_requests > 0 else 1.0
    if bad_rate > gates["maxFailedOrRejectedRate"]:
        reasons.append(
            f"failed_or_rejected_rate={bad_rate:.4f} > {gates['maxFailedOrRejectedRate']} "
            f"(failed={failed_requests}, rejected={rejected_requests}, offered={offered_requests})"
        )
    return {
        "provisional": bool(gates.get("provisional", True)),
        "qualityQualified": len(reasons) == 0,
        "disqualificationReasons": reasons,
        "failedOrRejectedRate": bad_rate,
    }


def compute_energy_accounting(
    *,
    query_sample: EnergySample,
    indexing_sample: EnergySample | None,
    idle_power_watts: float | None,
    overhead_joules: float | None,
    successful_queries: int,
    offered_queries: int,
    failed_requests: int,
    rejected_requests: int,
    quality_qualified: bool,
    scenarios: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Compute total, incremental, amortized, and quality-qualified joules per search."""
    if not query_sample.available or query_sample.joules is None:
        return {
            "available": False,
            "scope": query_sample.scope,
            "unavailableReason": query_sample.unavailable_reason,
            "totalQueryJoules": None,
            "incrementalQueryJoules": None,
            "totalIndexingJoules": None,
            "incrementalIndexingJoules": None,
            "idlePowerWatts": None,
            "measurementOverheadJoules": None,
            "joulesPerSuccessfulSearch": None,
            "joulesPerQualityQualifiedSearch": None,
            "qualityQualified": quality_qualified,
            "failedRequests": failed_requests,
            "rejectedRequests": rejected_requests,
            "amortizedScenarios": {
                name: {
                    "searchesPerPublish": cfg["searchesPerPublish"],
                    "searchesPerHour": cfg["searchesPerHour"],
                    "totalJoulesPerSearch": None,
                    "incrementalJoulesPerSearch": None,
                    "qualityQualifiedJoulesPerSearch": None,
                }
                for name, cfg in scenarios.items()
            },
        }

    overhead = overhead_joules or 0.0
    idle_w = idle_power_watts or 0.0
    total_q_j = max(0.0, query_sample.joules - overhead)
    inc_q_j = max(0.0, total_q_j - idle_w * query_sample.duration_seconds)

    total_idx_j: float | None = None
    inc_idx_j: float | None = None
    if indexing_sample is not None and indexing_sample.available and indexing_sample.joules is not None:
        total_idx_j = max(0.0, indexing_sample.joules - overhead)
        inc_idx_j = max(0.0, total_idx_j - idle_w * indexing_sample.duration_seconds)

    # Denominator is successful queries; if any requests failed/rejected or quality gates failed,
    # quality-qualified energy is NOT awarded (None) so rejecting work can never improve the metric.
    per_succ = (total_q_j / successful_queries) if successful_queries > 0 else None
    per_succ_inc = (inc_q_j / successful_queries) if successful_queries > 0 else None
    per_qual = per_succ if (quality_qualified and successful_queries > 0 and failed_requests == 0) else None

    amortized: dict[str, Any] = {}
    for name, cfg in scenarios.items():
        spp = float(cfg["searchesPerPublish"])
        sph = float(cfg["searchesPerHour"])
        idx_total_share = (total_idx_j / spp) if (total_idx_j is not None and spp > 0) else 0.0
        idx_inc_share = (inc_idx_j / spp) if (inc_idx_j is not None and spp > 0) else 0.0
        idle_share = (idle_w * 3600.0 / sph) if sph > 0 else 0.0
        tot_per = (per_succ + idx_total_share + idle_share) if per_succ is not None else None
        inc_per = (per_succ_inc + idx_inc_share) if per_succ_inc is not None else None
        amortized[name] = {
            "searchesPerPublish": cfg["searchesPerPublish"],
            "searchesPerHour": cfg["searchesPerHour"],
            "totalJoulesPerSearch": tot_per,
            "incrementalJoulesPerSearch": inc_per,
            "qualityQualifiedJoulesPerSearch": tot_per if (quality_qualified and failed_requests == 0) else None,
        }

    return {
        "available": True,
        "scope": query_sample.scope,
        "backend": query_sample.backend,
        "unavailableReason": None,
        "totalQueryJoules": total_q_j,
        "incrementalQueryJoules": inc_q_j,
        "totalIndexingJoules": total_idx_j,
        "incrementalIndexingJoules": inc_idx_j,
        "idlePowerWatts": idle_w,
        "measurementOverheadJoules": overhead,
        "offeredQueries": offered_queries,
        "successfulQueries": successful_queries,
        "failedRequests": failed_requests,
        "rejectedRequests": rejected_requests,
        "qualityQualified": quality_qualified,
        "joulesPerSuccessfulSearch": per_succ,
        "incrementalJoulesPerSuccessfulSearch": per_succ_inc,
        "joulesPerQualityQualifiedSearch": per_qual,
        "amortizedScenarios": amortized,
    }


def summarize_variability(values: Sequence[float]) -> dict[str, float | int]:
    if not values:
        return {"count": 0, "mean": 0.0, "median": 0.0, "min": 0.0, "max": 0.0, "stdev": 0.0, "iqr": 0.0}
    ordered = sorted(values)
    n = len(ordered)
    q1 = ordered[n // 4]
    q3 = ordered[(3 * n) // 4] if n >= 4 else ordered[-1]
    return {
        "count": n,
        "mean": statistics.fmean(ordered),
        "median": statistics.median(ordered),
        "min": ordered[0],
        "max": ordered[-1],
        "stdev": statistics.stdev(ordered) if n > 1 else 0.0,
        "iqr": q3 - q1,
    }


def _git_sha() -> str:
    try:
        return subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def _hardware_info() -> dict[str, Any]:
    cpu_model = platform.processor() or platform.machine()
    if platform.system() == "Darwin":
        try:
            cpu_model = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
        except Exception:
            pass
    elif platform.system() == "Linux":
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("model name"):
                    cpu_model = line.split(":", 1)[1].strip()
                    break
        except Exception:
            pass
    return {
        "os": platform.platform(),
        "arch": platform.machine(),
        "cpuModel": cpu_model,
        "cpuCores": os.cpu_count(),
        "python": platform.python_version(),
    }


def run_paired_baseline(
    config_path: Path,
    corpus_path: Path,
    queries_path: Path,
    out_path: Path,
    rounds: int = 3,
    concurrency: int = 4,
    churn_ops: int = 12,
    dotnet_bin: str = "dotnet",
    node_bin: str = "node",
    skip_build: bool = False,
) -> dict[str, Any]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    queries_doc = json.loads(queries_path.read_text(encoding="utf-8"))
    queries = queries_doc["queries"]

    if not skip_build:
        subprocess.run(
            [dotnet_bin, "build", str(PROTOCOL_CSPROJ), "-c", "Release", "--no-restore"],
            cwd=str(ROOT), check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )

    probe = EnergyProbe()
    # Idle baseline & measurement overhead calibration
    idle_sample_sec = float(config["energyModel"]["idleSampleSeconds"])
    _, idle_sample = probe.measure(lambda: time.sleep(idle_sample_sec))
    idle_power_w = (idle_sample.joules / idle_sample.duration_seconds) if (
        idle_sample.available and idle_sample.joules is not None and idle_sample.duration_seconds > 0
    ) else None
    _, overhead_sample = probe.measure(lambda: None)
    overhead_j = overhead_sample.joules if overhead_sample.available else None

    server_rounds: list[dict[str, Any]] = []
    local_rounds: list[dict[str, Any]] = []
    server_energy_samples: list[EnergySample] = []
    local_energy_samples: list[EnergySample] = []
    ordering: list[list[str]] = []

    with tempfile.TemporaryDirectory(prefix="fsus-search-eval-") as tmp:
        tmp_dir = Path(tmp)
        fspk_dir = tmp_dir / "fspk"

        # Seed FSPK pages once during warm-up so alternating orders can start with either engine
        warmup_out = tmp_dir / "warmup-server.json"
        subprocess.run(
            [
                dotnet_bin, "run", "--project", str(PROTOCOL_CSPROJ), "-c", "Release", "--no-build", "--",
                "--search-eval", "--corpus", str(corpus_path), "--queries", str(queries_path),
                "--out", str(warmup_out), "--emit-fspk-dir", str(fspk_dir),
                "--iterations", "1", "--concurrency", str(concurrency), "--churn-ops", "3",
            ],
            cwd=str(ROOT), check=True,
        )

        for r in range(rounds):
            order = ["server", "local"] if r % 2 == 0 else ["local", "server"]
            ordering.append(order)
            for engine in order:
                if engine == "server":
                    out_file = tmp_dir / f"server-round-{r}.json"
                    cmd = [
                        dotnet_bin, "run", "--project", str(PROTOCOL_CSPROJ), "-c", "Release", "--no-build", "--",
                        "--search-eval", "--corpus", str(corpus_path), "--queries", str(queries_path),
                        "--out", str(out_file), "--iterations", "2", "--concurrency", str(concurrency),
                        "--churn-ops", str(churn_ops),
                    ]
                    _, sample = probe.measure(lambda c=cmd: subprocess.run(c, cwd=str(ROOT), check=True))
                    server_rounds.append(json.loads(out_file.read_text(encoding="utf-8")))
                    server_energy_samples.append(sample)
                else:
                    out_file = tmp_dir / f"local-round-{r}.json"
                    cmd = [
                        node_bin, str(LOCAL_SCRIPT), "--fspk-dir", str(fspk_dir),
                        "--queries", str(queries_path), "--out", str(out_file),
                        "--concurrency", str(concurrency),
                    ]
                    _, sample = probe.measure(lambda c=cmd: subprocess.run(c, cwd=str(ROOT), check=True))
                    local_rounds.append(json.loads(out_file.read_text(encoding="utf-8")))
                    local_energy_samples.append(sample)

    server_ref = server_rounds[0]
    local_ref = local_rounds[0]

    server_rel = compute_relevance_report(queries, server_ref["results"])
    local_rel = compute_relevance_report(queries, local_ref["results"])
    cross_path_eq = compute_equivalence_check(server_ref["results"], local_ref["results"], top_k=10)

    gates = config["provisionalGates"]
    scenarios = config["energyModel"]["amortizationScenarios"]
    net_model = config["energyModel"]["networkEnergyEstimate"]

    server_p95_median = statistics.median(r["queryPass"]["latencyMs"]["p95"] for r in server_rounds)
    local_p95_median = statistics.median(r["warmSession"]["latencyMs"]["p95"] for r in local_rounds)

    server_gate = evaluate_provisional_gates(
        server_rel["holdout"], server_p95_median,
        server_ref["queryPass"]["offered"], server_ref["queryPass"]["failed"], 0, gates,
    )
    local_gate = evaluate_provisional_gates(
        local_rel["holdout"], local_p95_median,
        local_ref["warmSession"]["offered"], local_ref["warmSession"]["failed"],
        local_ref["warmSession"]["rejected"], gates,
    )

    server_energy = compute_energy_accounting(
        query_sample=server_energy_samples[0],
        indexing_sample=None,
        idle_power_watts=idle_power_w,
        overhead_joules=overhead_j,
        successful_queries=server_ref["queryPass"]["succeeded"],
        offered_queries=server_ref["queryPass"]["offered"],
        failed_requests=server_ref["queryPass"]["failed"],
        rejected_requests=0,
        quality_qualified=server_gate["qualityQualified"],
        scenarios=scenarios,
    )
    local_energy = compute_energy_accounting(
        query_sample=local_energy_samples[0],
        indexing_sample=None,
        idle_power_watts=idle_power_w,
        overhead_joules=overhead_j,
        successful_queries=local_ref["warmSession"]["succeeded"],
        offered_queries=local_ref["warmSession"]["offered"],
        failed_requests=local_ref["warmSession"]["failed"],
        rejected_requests=local_ref["warmSession"]["rejected"],
        quality_qualified=local_gate["qualityQualified"],
        scenarios=scenarios,
    )

    report = {
        "schemaVersion": "fsusblog-search-eval-report-v1",
        "generatedAtUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "gitCommit": _git_sha(),
        "hardware": _hardware_info(),
        "config": {
            "schemaVersion": config["schemaVersion"],
            "corpusVersion": config["corpusVersion"],
            "querySetVersion": config["querySetVersion"],
            "judgmentsVersion": config["judgmentsVersion"],
            "analyzerProfile": config["analyzerProfile"],
            "scoringProfile": config["scoringProfile"],
            "provenance": config["provenance"],
        },
        "pairedProtocol": {
            "rounds": rounds,
            "alternatingOrder": ordering,
            "warmupExecuted": True,
            "idleSampleSeconds": idle_sample_sec,
            "idlePowerWatts": idle_power_w,
            "measurementOverheadJoules": overhead_j,
            "energyProbeAvailable": probe.available,
            "energyProbeScope": probe.scope,
            "energyProbeUnavailableReason": probe.unavailable_reason,
        },
        "corpusStats": server_ref["corpus"],
        "engines": {
            "server-fas4": {
                "runtime": server_ref["runtime"],
                "buildConfig": server_ref["buildConfig"],
                "relevance": server_rel,
                "gateDecision": server_gate,
                "variabilityAcrossRounds": {
                    "serverBuildWallMs": summarize_variability([r["indexing"]["serverBuildWallMs"] for r in server_rounds]),
                    "queryP50Ms": summarize_variability([r["queryPass"]["latencyMs"]["p50"] for r in server_rounds]),
                    "queryP95Ms": summarize_variability([r["queryPass"]["latencyMs"]["p95"] for r in server_rounds]),
                    "queryP99Ms": summarize_variability([r["queryPass"]["latencyMs"]["p99"] for r in server_rounds]),
                    "rareP95Ms": summarize_variability([r["queryPass"]["rareLatencyMs"]["p95"] for r in server_rounds]),
                    "commonP95Ms": summarize_variability([r["queryPass"]["commonLatencyMs"]["p95"] for r in server_rounds]),
                    "repeatedHotP95Ms": summarize_variability([r["repeatedHot"]["latencyMs"]["p95"] for r in server_rounds]),
                    "concurrentThroughputQps": summarize_variability([r["concurrent"]["throughputQps"] for r in server_rounds]),
                    "churnServerRebuildP95Ms": summarize_variability([r["publicationChurn"]["serverRebuildLatencyMs"]["p95"] for r in server_rounds]),
                    **(
                        {
                            "v2EndToEndP95Ms": summarize_variability([r["v2PayloadAndSnippets"]["endToEndLatencyMs"]["p95"] for r in server_rounds]),
                            "v2SnippetOnlyP95Ms": summarize_variability([r["v2PayloadAndSnippets"]["snippetOnlyLatencyMs"]["p95"] for r in server_rounds]),
                        }
                        if all("v2PayloadAndSnippets" in r for r in server_rounds)
                        else {}
                    ),
                },
                "latestRoundMetrics": {
                    "indexing": server_ref["indexing"],
                    "queryPass": server_ref["queryPass"],
                    **({"v2PayloadAndSnippets": server_ref["v2PayloadAndSnippets"]} if "v2PayloadAndSnippets" in server_ref else {}),
                    **({"broadCorpusPruning": server_ref["broadCorpusPruning"]} if "broadCorpusPruning" in server_ref else {}),
                    "repeatedHot": server_ref["repeatedHot"],
                    "concurrent": server_ref["concurrent"],
                    "cancellation": server_ref["cancellation"],
                    "publicationChurn": server_ref["publicationChurn"],
                },
                "energy": server_energy,
                "networkEnergyEstimate": estimate_network_energy_joules(
                    server_ref["queryPass"]["totalResponseBytes"], net_model["joulesPerMegabyte"],
                ),
            },
            "local-fspk-v4": {
                "runtime": local_ref["runtime"],
                "relevance": local_rel,
                "gateDecision": local_gate,
                "variabilityAcrossRounds": {
                    "coldSessionP50Ms": summarize_variability([r["coldSession"]["latencyMs"]["p50"] for r in local_rounds]),
                    "warmQueryP50Ms": summarize_variability([r["warmSession"]["latencyMs"]["p50"] for r in local_rounds]),
                    "warmQueryP95Ms": summarize_variability([r["warmSession"]["latencyMs"]["p95"] for r in local_rounds]),
                    "warmQueryP99Ms": summarize_variability([r["warmSession"]["latencyMs"]["p99"] for r in local_rounds]),
                    "rareP95Ms": summarize_variability([r["warmSession"]["rareLatencyMs"]["p95"] for r in local_rounds]),
                    "commonP95Ms": summarize_variability([r["warmSession"]["commonLatencyMs"]["p95"] for r in local_rounds]),
                    "concurrentThroughputQps": summarize_variability([r["concurrent"]["throughputQps"] for r in local_rounds]),
                },
                "latestRoundMetrics": {
                    "coldSession": local_ref["coldSession"],
                    "warmSession": local_ref["warmSession"],
                    "concurrent": local_ref["concurrent"],
                    "cancellation": local_ref["cancellation"],
                },
                "energy": local_energy,
                "coldSessionNetworkEnergyEstimate": estimate_network_energy_joules(
                    local_ref["coldSession"]["transferredBytes"], net_model["joulesPerMegabyte"],
                ),
            },
        },
        "equivalenceChecks": {
            "serverVsLocalTop10": cross_path_eq,
        },
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def print_summary(report: Mapping[str, Any]) -> None:
    print(f"=== FsusBlog Search Evaluation Report ({report['config']['analyzerProfile']} / {report['config']['scoringProfile']}) ===")
    print(f"Commit: {report['gitCommit'][:12]} | Hardware: {report['hardware']['cpuModel']} ({report['hardware']['cpuCores']} cores)")
    print(f"Energy probe: available={report['pairedProtocol']['energyProbeAvailable']} scope={report['pairedProtocol']['energyProbeScope']}")
    for name, eng in report["engines"].items():
        ho = eng["relevance"]["holdout"]
        tu = eng["relevance"]["tuning"]
        gd = eng["gateDecision"]
        print(
            f"- {name}: holdout nDCG@10={ho['ndcgAt10']:.4f} MRR@10={ho['mrrAt10']:.4f} "
            f"S@3={ho['targetSuccessAt3']:.4f} R@10={ho['recallAt10']:.4f} "
            f"NoMatchFPR={ho['noMatchFalsePositiveRate']:.4f} | "
            f"tuning S@3={tu['targetSuccessAt3']:.4f} | qualified={gd['qualityQualified']}"
        )
    eq = report["equivalenceChecks"]["serverVsLocalTop10"]
    print(f"- Server vs Local top-10 exact agreement: {eq['exactOrderMatches']}/{eq['comparedQueries']} ({eq['agreementRate']:.2%})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="Execute paired search evaluation and write JSON report")
    run_p.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    run_p.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    run_p.add_argument("--queries", type=Path, default=DEFAULT_QUERIES)
    run_p.add_argument("--out", type=Path, required=True)
    run_p.add_argument("--rounds", type=int, default=3)
    run_p.add_argument("--concurrency", type=int, default=4)
    run_p.add_argument("--churn-ops", type=int, default=12)
    run_p.add_argument("--skip-build", action="store_true")

    sub.add_parser("verify-dataset", help="Verify dataset integrity and SHA-256 provenance")

    args = parser.parse_args()
    if args.command == "verify-dataset":
        import search_eval_dataset
        search_eval_dataset.verify()
        return 0

    report = run_paired_baseline(
        config_path=args.config,
        corpus_path=args.corpus,
        queries_path=args.queries,
        out_path=args.out,
        rounds=args.rounds,
        concurrency=args.concurrency,
        churn_ops=args.churn_ops,
        skip_build=args.skip_build,
    )
    print_summary(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
