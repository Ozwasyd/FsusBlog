from datetime import datetime, timedelta, timezone
import unittest

from runtime import summarize_slow_requests


class SlowRequestTest(unittest.TestCase):
    def test_completion_buckets_and_independent_pause_intersections(self):
        epoch = datetime(2026, 1, 1, tzinfo=timezone.utc)

        def at(milliseconds):
            return (epoch + timedelta(milliseconds=milliseconds)).isoformat()

        rows = [{"slowRequestThresholdMs": 20, "slowRequestOmitted": 0, "slowRequests": [
            {"StartUtc": at(990), "EndUtc": at(1030), "Milliseconds": 40},
            {"StartUtc": at(1050), "EndUtc": at(1070), "Milliseconds": 20},
        ]}]
        load = {"measurementStartedAt": at(0), "measurementCompletedAt": at(2000),
                "supplyBySecond": [{"second": 1, "dropped": 17}],
                "slowRequests": {"thresholdMs": 20, "omitted": 0, "requests": [
                    {"plannedUtc": at(975), "workerUtc": at(980), "writtenUtc": at(985),
                     "headersUtc": at(1015), "bodyUtc": at(1031), "finishedUtc": at(1032),
                     "phasesMs": {"plannedToWorker": 5, "workerToWrite": 5, "writeToHeaders": 30,
                                  "headersToBody": 16, "bodyToFinish": 1}},
                    {"plannedUtc": at(1060), "workerUtc": at(1061), "finishedUtc": at(1090),
                     "phasesMs": {"plannedToWorker": 1}},
                ]}}
        gc = [{"StartUtc": at(1001), "EndUtc": at(1011), "Milliseconds": 10, "SuspensionMilliseconds": 7}]

        result = summarize_slow_requests(rows, load, gc, epoch, epoch + timedelta(seconds=2))
        self.assertTrue(result["complete"])
        self.assertEqual(2, result["server"]["retained"])
        self.assertEqual(1, result["server"]["intersectedClrPause"])
        self.assertEqual(1, result["client"]["transferIntersectedClrPause"])
        self.assertEqual({"count": 1, "p95Ms": 30.0, "maxMs": 30.0}, result["client"]["phases"]["writeToHeaders"])
        self.assertEqual([{"second": 1, "server": 2, "client": 2, "gcSuspensionMs": 7.0,
                           "schedulerDropped": 17}], result["secondsWithEvents"])

        rows[0]["slowRequestOmitted"] = 1
        self.assertFalse(summarize_slow_requests(rows, load, gc, epoch, epoch + timedelta(seconds=2))["complete"])
