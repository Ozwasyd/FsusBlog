#!/usr/bin/env python3
"""Deterministic unit tests for the public search evaluation harness (#44)."""

from __future__ import annotations

import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import search_eval
import search_eval_dataset


class SearchEvalDatasetTests(unittest.TestCase):
    def test_versioned_dataset_provenance_and_split_balance(self) -> None:
        search_eval_dataset.verify()
        config = json.loads(search_eval_dataset.CONFIG_PATH.read_text(encoding="utf-8"))
        queries_doc = json.loads(search_eval_dataset.QUERIES_PATH.read_text(encoding="utf-8"))
        corpus_doc = json.loads(search_eval_dataset.CORPUS_PATH.read_text(encoding="utf-8"))

        self.assertTrue(config["provisionalGates"]["provisional"])
        self.assertEqual(config["provenance"]["corpusType"], "synthetic")
        self.assertFalse(config["provenance"]["containsPrivateDrafts"])
        self.assertFalse(config["provenance"]["containsReaderQueryHistory"])
        self.assertGreaterEqual(len(queries_doc["queries"]), 300)
        self.assertLessEqual(len(queries_doc["queries"]), 500)
        self.assertGreater(len(corpus_doc["articles"]), 400)

        tuning = [q for q in queries_doc["queries"] if q["split"] == "tuning"]
        holdout = [q for q in queries_doc["queries"] if q["split"] == "holdout"]
        self.assertEqual(len(tuning), len(holdout))
        self.assertEqual(len(queries_doc["categories"]), 12)


class SearchEvalMetricsTests(unittest.TestCase):
    def test_graded_ndcg_mrr_success_and_recall(self) -> None:
        judgments = {10: 3, 20: 2, 30: 1}
        self.assertAlmostEqual(search_eval.ndcg_at_k([10, 20, 30], judgments, 10), 1.0, places=9)
        self.assertAlmostEqual(search_eval.mrr_at_k([99, 20, 10], judgments, 10), 0.5, places=9)
        self.assertEqual(search_eval.target_success_at_k([99, 88, 10], [10], 3), 1.0)
        self.assertEqual(search_eval.target_success_at_k([99, 88, 77, 10], [10], 3), 0.0)
        self.assertAlmostEqual(search_eval.recall_at_k([10, 99, 30], judgments, 10), 2.0 / 3.0, places=9)
        # Duplicate document IDs cannot inflate nDCG
        dup_ndcg = search_eval.ndcg_at_k([10, 10, 10], judgments, 10)
        single_ndcg = search_eval.ndcg_at_k([10], judgments, 10)
        self.assertAlmostEqual(dup_ndcg, single_ndcg, places=9)

    def test_relevance_report_keeps_tuning_and_holdout_separate_and_tracks_no_match_fpr(self) -> None:
        queries = [
            {
                "id": "q-1", "split": "tuning", "category": "chinese_dict", "query": "博客搜索",
                "expectedEmpty": False, "targetArticleIds": [1], "judgments": {"1": 3},
            },
            {
                "id": "q-2", "split": "holdout", "category": "chinese_dict", "query": "公开页",
                "expectedEmpty": False, "targetArticleIds": [2], "judgments": {"2": 3},
            },
            {
                "id": "q-3", "split": "holdout", "category": "no_match", "query": "absent",
                "expectedEmpty": True, "targetArticleIds": [], "judgments": {},
            },
        ]
        results = [
            {"id": "q-1", "ok": True, "articleIds": [1], "total": 1},
            {"id": "q-2", "ok": True, "articleIds": [9, 8, 7, 2], "total": 4},
            {"id": "q-3", "ok": True, "articleIds": [5], "total": 1},
        ]
        report = search_eval.compute_relevance_report(queries, results)
        self.assertEqual(report["tuning"]["targetSuccessAt3"], 1.0)
        self.assertEqual(report["holdout"]["targetSuccessAt3"], 0.0)
        self.assertEqual(report["holdout"]["noMatchFalsePositiveRate"], 1.0)
        self.assertEqual(report["holdout"]["noMatchFalsePositives"], 1)

    def test_equivalence_check_is_separate_from_relevance(self) -> None:
        ref = [
            {"id": "q-1", "ok": True, "articleIds": [1, 2, 3]},
            {"id": "q-2", "ok": True, "articleIds": [4, 5]},
        ]
        cand = [
            {"id": "q-1", "ok": True, "articleIds": [1, 2, 3]},
            {"id": "q-2", "ok": True, "articleIds": [5, 4]},
        ]
        eq = search_eval.compute_equivalence_check(ref, cand, top_k=10)
        self.assertEqual(eq["comparedQueries"], 2)
        self.assertEqual(eq["exactOrderMatches"], 1)
        self.assertAlmostEqual(eq["agreementRate"], 0.5)
        self.assertEqual(eq["mismatchSamples"][0]["id"], "q-2")


class SearchEvalEnergyAndGateTests(unittest.TestCase):
    def test_missing_instrumentation_reports_unavailable_never_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            probe = search_eval.EnergyProbe(rapl_root=Path(tmp) / "missing", system_name="Linux")
            self.assertFalse(probe.available)
            self.assertEqual(probe.scope, "unavailable")
            self.assertIsNotNone(probe.unavailable_reason)
            _, sample = probe.measure(lambda: 42)
            self.assertFalse(sample.available)
            self.assertIsNone(sample.joules)

            acct = search_eval.compute_energy_accounting(
                query_sample=sample,
                indexing_sample=None,
                idle_power_watts=None,
                overhead_joules=None,
                successful_queries=100,
                offered_queries=100,
                failed_requests=0,
                rejected_requests=0,
                quality_qualified=True,
                scenarios={"balanced": {"searchesPerPublish": 500, "searchesPerHour": 600}},
            )
            self.assertFalse(acct["available"])
            self.assertIsNone(acct["totalQueryJoules"])
            self.assertIsNone(acct["incrementalQueryJoules"])
            self.assertIsNone(acct["joulesPerQualityQualifiedSearch"])
            self.assertIsNone(acct["amortizedScenarios"]["balanced"]["totalJoulesPerSearch"])

    def test_rapl_wraparound_amortization_and_rejection_disqualification(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / "intel-rapl:0"
            pkg.mkdir()
            (pkg / "name").write_text("package-0\n", encoding="utf-8")
            (pkg / "max_energy_range_uj").write_text("10000000\n", encoding="utf-8")
            (pkg / "energy_uj").write_text("9500000\n", encoding="utf-8")
            # Subzone should be ignored to avoid double-counting CPU package energy
            sub = Path(tmp) / "intel-rapl:0:0"
            sub.mkdir()
            (sub / "energy_uj").write_text("100000\n", encoding="utf-8")

            probe = search_eval.EnergyProbe(rapl_root=Path(tmp), system_name="Linux")
            self.assertTrue(probe.available)
            self.assertEqual(probe.scope, "cpu_package")
            # Wrap from 9.5 J -> 0.5 J across 10.0 J max range = 1.0 J
            self.assertAlmostEqual(probe.delta_joules([9_500_000], [500_000]), 1.0, places=9)

            q_sample = search_eval.EnergySample(True, "cpu_package", 12.0, 2.0, None, "linux-powercap-rapl")
            i_sample = search_eval.EnergySample(True, "cpu_package", 50.0, 5.0, None, "linux-powercap-rapl")
            scenarios = {"balanced": {"searchesPerPublish": 500, "searchesPerHour": 600}}

            ok_acct = search_eval.compute_energy_accounting(
                query_sample=q_sample, indexing_sample=i_sample,
                idle_power_watts=1.0, overhead_joules=0.0,
                successful_queries=100, offered_queries=100,
                failed_requests=0, rejected_requests=0,
                quality_qualified=True, scenarios=scenarios,
            )
            self.assertAlmostEqual(ok_acct["totalQueryJoules"], 12.0)
            self.assertAlmostEqual(ok_acct["incrementalQueryJoules"], 10.0)
            self.assertAlmostEqual(ok_acct["totalIndexingJoules"], 50.0)
            self.assertAlmostEqual(ok_acct["incrementalIndexingJoules"], 45.0)
            self.assertAlmostEqual(ok_acct["joulesPerQualityQualifiedSearch"], 0.12)
            # Incremental amortized = 10/100 + 45/500 = 0.10 + 0.09 = 0.19 J/search
            self.assertAlmostEqual(ok_acct["amortizedScenarios"]["balanced"]["incrementalJoulesPerSearch"], 0.19)

            # Rejecting work disqualifies the run from quality-qualified energy
            gates = {
                "provisional": True, "serverLatencyP95MsMax": 30.0,
                "targetSuccessAt3Min": 0.95, "heldOutNdcgAt10Min": 0.85,
                "noMatchFalsePositiveRateMax": 0.05, "maxFailedOrRejectedRate": 0.001,
            }
            rejected_gate = search_eval.evaluate_provisional_gates(
                {"ndcgAt10": 0.99, "targetSuccessAt3": 0.99, "noMatchFalsePositiveRate": 0.0},
                p95_latency_ms=5.0, offered_requests=100, failed_requests=0, rejected_requests=10, gates=gates,
            )
            self.assertFalse(rejected_gate["qualityQualified"])
            bad_acct = search_eval.compute_energy_accounting(
                query_sample=q_sample, indexing_sample=i_sample,
                idle_power_watts=1.0, overhead_joules=0.0,
                successful_queries=90, offered_queries=100,
                failed_requests=0, rejected_requests=10,
                quality_qualified=rejected_gate["qualityQualified"], scenarios=scenarios,
            )
            self.assertIsNone(bad_acct["joulesPerQualityQualifiedSearch"])
            self.assertIsNone(bad_acct["amortizedScenarios"]["balanced"]["qualityQualifiedJoulesPerSearch"])

    def test_network_estimate_is_marked_as_estimate_and_variability_stats(self) -> None:
        net = search_eval.estimate_network_energy_joules(1024 * 1024, 0.06)
        self.assertTrue(net["isEstimate"])
        self.assertAlmostEqual(net["estimatedJoules"], 0.06)
        var = search_eval.summarize_variability([1.0, 2.0, 3.0, 4.0])
        self.assertEqual(var["count"], 4)
        self.assertAlmostEqual(var["mean"], 2.5)
        self.assertAlmostEqual(var["median"], 2.5)
        self.assertGreater(var["stdev"], 0.0)


if __name__ == "__main__":
    unittest.main()
