"""
Tests for the counterfactual pipeline (counterfactuals.py and the scorer's
counterfactuals action). Self-contained: small XGBoost models are fitted on
synthetic data with the real feature-contract column names.

    cd backend/lambdas/risk-scorer && python -m unittest test_counterfactuals -v
"""
import unittest
from unittest import mock

import numpy as np
import xgboost

import counterfactuals as cf
import handler

SUBJECTS = cf.SUBJECTS


def columns(point):
    upto = cf.POINTS[: cf.POINTS.index(point) + 1]
    return [f"{p}_{s}" for p in upto for s in SUBJECTS] + [f"Attendance_{p}" for p in upto]


def fit(point, seed):
    """A model whose risk falls as the latest checkpoint's marks and attendance rise."""
    rng = np.random.default_rng(seed)
    cols = columns(point)
    X = rng.uniform(20, 95, size=(1500, len(cols)))
    latest = [i for i, c in enumerate(cols) if c.startswith(f"{point}_") or c == f"Attendance_{point}"]
    y = (X[:, latest].mean(axis=1) < 55).astype(int)
    booster = xgboost.train({"objective": "binary:logistic", "max_depth": 3, "eta": 0.3, "seed": seed},
                            xgboost.DMatrix(X.astype(np.float32), label=y, feature_names=cols), num_boost_round=40)
    return booster, cols


BOOSTERS = {p: fit(p, i + 1) for i, p in enumerate(["T1M", "T1F", "T2M", "T2F", "T3M"])}


def stats(mark_cap=12.0, attendance_cap=4.0, improvement=3.0):
    peers = [[5, 120, improvement] for _ in range(101)]
    trans = {}
    for a, b in zip(cf.POINTS[:4], cf.POINTS[1:5]):
        trans[f"{a}>{b}"] = {
            "from": a, "to": b,
            "caps": {**{s: mark_cap for s in SUBJECTS}, "Attendance": attendance_cap},
            "peers": {**{s: peers for s in SUBJECTS}, "Attendance": peers},
        }
    trans["T3M>T3F"] = {"from": "T3M", "to": "T3F", "caps": {}, "peers": {}}
    return {"version": 1, "settings": {"target_percentile": 75}, "transitions": trans}


def student(point, mark, attendance=80.0, missing=()):
    values = {c: (attendance if c.startswith("Attendance_") else mark) for c in columns(point)}
    for s in missing:
        values[f"{point}_{s}"] = None
    return values


def evaluation(point):
    nxt = cf.NEXT[point]
    booster, cols = BOOSTERS[nxt]
    return cf.ModelEvaluation(nxt, booster, cols, 0.5)


RULES = {"static_mark_cap": 20.0, "static_attendance_cap": 10.0, "options": 3, "seed": 20261}


def apply(base, option):
    row = dict(base)
    row.update({ch["feature"]: ch["to"] for ch in option["changes"]})
    return row


class Baseline(unittest.TestCase):
    def test_carries_current_results_forward_and_keeps_missing(self):
        values = student("T1M", 40, 70, missing=["Physics"])
        base = cf.baseline("T1M", values)
        self.assertEqual(base["T1F_Kiswahili"], 40)
        self.assertEqual(base["Attendance_T1F"], 70)
        self.assertIsNone(base["T1F_Physics"])
        self.assertEqual(base["T1M_Kiswahili"], values["T1M_Kiswahili"])  # history unchanged

    def test_t3m_baseline_has_no_attendance(self):
        base = cf.baseline("T3M", student("T3M", 45))
        self.assertNotIn("Attendance_T3F", base)
        self.assertEqual(base["T3F_English"], 45)


class Caps(unittest.TestCase):
    def test_data_caps_and_static_fallback(self):
        base = cf.baseline("T1M", student("T1M", 40, 70))
        with_data = cf.caps("T1M", base, stats(), None, RULES)
        self.assertEqual(with_data["T1F_Kiswahili"]["max_increase"], 12.0)
        self.assertEqual(with_data["T1F_Kiswahili"]["source"], "data")
        self.assertEqual(with_data["Attendance_T1F"]["max_increase"], 4.0)
        static = cf.caps("T1M", base, None, None, RULES)
        self.assertEqual(static["T1F_Kiswahili"]["max_increase"], 20.0)
        self.assertEqual(static["Attendance_T1F"]["max_increase"], 10.0)
        self.assertEqual(static["T1F_Kiswahili"]["source"], "static")

    def test_attendance_ceiling_binds_when_lower(self):
        base = cf.baseline("T1M", student("T1M", 40, 70))
        # 21 of 30 counted days attended; 5 more school days -> at most 26/35 = 74.29%
        limits = cf.caps("T1M", base, stats(attendance_cap=8.0), {"attended": 21, "counted": 30, "next_school_days": 5}, RULES)
        self.assertEqual(limits["Attendance_T1F"]["source"], "ceiling")
        self.assertAlmostEqual(limits["Attendance_T1F"]["max_value"], 26 / 35 * 100, places=3)

    def test_never_above_100_and_missing_has_no_cap(self):
        base = cf.baseline("T1M", student("T1M", 95, 99, missing=["History"]))
        limits = cf.caps("T1M", base, stats(), None, RULES)
        self.assertEqual(limits["T1F_English"]["max_value"], 100.0)
        self.assertEqual(limits["Attendance_T1F"]["max_value"], 100.0)
        self.assertNotIn("T1F_History", limits)

    def test_t3m_uses_static_mark_caps(self):
        base = cf.baseline("T3M", student("T3M", 40))
        limits = cf.caps("T3M", base, stats(), None, RULES)
        self.assertTrue(all(v["source"] == "static" and v["max_increase"] == 20.0 for v in limits.values()))
        self.assertFalse(any(k.startswith("Attendance") for k in limits))


class Generate(unittest.TestCase):
    def check_within_caps(self, result):
        for option in result["options"]:
            for ch in option["changes"]:
                lim = result["caps"][ch["feature"]]
                self.assertGreater(ch["to"], ch["from"])
                self.assertLessEqual(ch["to"], lim["max_value"] + 1e-9)
                self.assertLessEqual(ch["to"], 100.0)

    def check_projection(self, point, values, result, ev):
        base = cf.baseline(point, values)
        for option in result["options"]:
            score = ev.scores([apply(base, option)])[0]
            self.assertAlmostEqual(score, option["score"], places=5)
            self.assertEqual(ev.at_risk(score), option["at_risk"])

    def test_dice_uses_the_next_checkpoint_model(self):
        values = student("T1M", 48, 80)
        ev = evaluation("T1M")
        result = cf.generate("T1M", values, ev, stats(), None, RULES)
        self.assertEqual(result["target_point"], "T1F")
        self.assertEqual(result["evaluation"]["model_point"], "T1F")
        base = cf.baseline("T1M", values)
        self.assertAlmostEqual(result["evaluation"]["baseline_score"], ev.scores([base])[0], places=5)
        self.assertEqual(result["status"], "FOUND")
        self.assertEqual(result["method"], cf.DICE)
        self.assertTrue(all(not o["at_risk"] for o in result["options"]))
        self.check_within_caps(result)
        self.check_projection("T1M", values, result, ev)

    def test_fallback_only_when_dice_cannot(self):
        values = student("T1M", 25, 50)  # far below: small caps cannot clear the model
        ev = evaluation("T1M")
        result = cf.generate("T1M", values, ev, stats(mark_cap=3.0, attendance_cap=1.0), None, RULES)
        self.assertEqual(result["status"], "FALLBACK")
        self.assertEqual(result["method"], cf.PEERS)
        self.assertFalse(result["dice"]["found"])
        self.check_within_caps(result)
        self.check_projection("T1M", values, result, ev)
        found = cf.generate("T1M", student("T1M", 48, 80), ev, stats(), None, RULES)
        self.assertEqual(found["status"], "FOUND")
        self.assertTrue(all(o["method"] == cf.DICE for o in found["options"]))

    def test_fallback_rule_peer_change_or_cap(self):
        ev = evaluation("T1M")
        positive = cf.generate("T1M", student("T1M", 25, 50), ev, stats(mark_cap=3.0, attendance_cap=1.0, improvement=2.0), None, RULES)
        for ch in positive["options"][0]["changes"]:
            self.assertEqual(ch["basis"], "peer")
            expected = cf.tidy(ch["feature"], ch["from"] + 2.0, positive["caps"][ch["feature"]]["max_value"]) \
                if not ch["feature"].startswith("Attendance") else cf.tidy(ch["feature"], ch["from"] + 1.0, positive["caps"][ch["feature"]]["max_value"])
            self.assertEqual(ch["to"], expected)
        negative = cf.generate("T1M", student("T1M", 25, 50), ev, stats(mark_cap=3.0, attendance_cap=1.0, improvement=-1.0), None, RULES)
        for ch in negative["options"][0]["changes"]:
            self.assertEqual(ch["basis"], "cap")
            self.assertEqual(ch["to"], negative["caps"][ch["feature"]]["max_value"])
        no_peers = stats(mark_cap=3.0, attendance_cap=1.0)
        for t in no_peers["transitions"].values():
            t["peers"] = {k: [None] * 101 for k in t["peers"]}
        none = cf.generate("T1M", student("T1M", 25, 50), ev, no_peers, None, RULES)
        self.assertTrue(all(ch["basis"] == "cap" and ch["peer"] is None for ch in none["options"][0]["changes"]))

    def test_missing_results_get_no_targets(self):
        values = student("T1M", 25, 50, missing=["Physics", "History"])
        result = cf.generate("T1M", values, evaluation("T1M"), stats(mark_cap=3.0, attendance_cap=1.0), None, RULES)
        touched = {ch["feature"] for o in result["options"] for ch in o["changes"]}
        self.assertNotIn("T1F_Physics", touched)
        self.assertNotIn("T1F_History", touched)

    def test_rounding(self):
        result = cf.generate("T1M", student("T1M", 25.3, 50.04), evaluation("T1M"), stats(mark_cap=3.0, attendance_cap=1.0), None, RULES)
        for ch in result["options"][0]["changes"]:
            if ch["feature"].startswith("Attendance"):
                self.assertEqual(round(ch["to"], 1), ch["to"])
            else:
                self.assertEqual(float(int(ch["to"])), ch["to"])

    def test_maintain_when_the_baseline_already_clears(self):
        result = cf.generate("T1M", student("T1M", 90, 98), evaluation("T1M"), stats(), None, RULES)
        self.assertEqual(result["status"], "MAINTAIN")
        self.assertEqual(result["options"], [])

    def test_deterministic(self):
        ev = evaluation("T1M")
        for values in (student("T1M", 48, 80), student("T1M", 25, 50)):
            a = cf.generate("T1M", values, ev, stats(), None, RULES)
            b = cf.generate("T1M", values, ev, stats(), None, RULES)
            self.assertEqual(a, b)


class PassMark(unittest.TestCase):
    def test_policies(self):
        row = {f"T3F_{s}": 60.0 for s in SUBJECTS[:6]}
        self.assertAlmostEqual(cf.PassMarkRule(50, "EXCLUDE").average(row), 60.0)
        self.assertAlmostEqual(cf.PassMarkRule(50, "ZERO").average(row), 40.0)
        self.assertTrue(cf.PassMarkRule(50, "ZERO").at_risk(40.0))
        self.assertFalse(cf.PassMarkRule(50, "EXCLUDE").at_risk(60.0))

    def test_t3m_targets_reach_the_pass_mark(self):
        rule = cf.PassMarkRule(55, "EXCLUDE")
        values = student("T3M", 48, missing=["Physics"])
        result = cf.generate("T3M", values, rule, stats(), None, RULES)
        self.assertEqual(result["evaluation"]["kind"], "pass_mark_rule")
        self.assertEqual(result["target_point"], "T3F")
        self.assertEqual(result["status"], "FOUND")
        base = cf.baseline("T3M", values)
        for option in result["options"]:
            avg = rule.average(apply(base, option))
            self.assertGreaterEqual(avg, 55)
            self.assertAlmostEqual(avg, option["score"], places=5)
            self.assertNotIn("T3F_Physics", {ch["feature"] for ch in option["changes"]})

    def test_t3m_fallback_without_peer_data_uses_the_cap(self):
        rule = cf.PassMarkRule(80, "EXCLUDE")
        result = cf.generate("T3M", student("T3M", 40), rule, stats(), None, RULES)
        self.assertEqual(result["status"], "FALLBACK")
        self.assertTrue(all(ch["basis"] == "cap" and ch["to"] == 60.0 for ch in result["options"][0]["changes"]))


class FakeModel:
    version = "test-v1"

    def __init__(self, with_stats=True):
        self.with_stats = with_stats

    def point(self, point):
        return {"features": BOOSTERS[point][1], "threshold": 0.5}

    def booster(self, point):
        return BOOSTERS[point][0]

    def counterfactual_stats(self):
        return stats() if self.with_stats else None


class Handler(unittest.TestCase):
    def test_action_picks_next_model_or_rule(self):
        with mock.patch.object(handler.model_store, "load", return_value=FakeModel()):
            out = handler.handler({"action": "counterfactuals", "prediction_point": "T2M", "model_version": "test-v1",
                                   "rows": [{"row_id": 0, "features": student("T2M", 48, 80)}]})
            self.assertEqual(out["evaluation"]["model_point"], "T2F")
            self.assertEqual(out["results"][0]["evaluation"]["model_point"], "T2F")
            out = handler.handler({"action": "counterfactuals", "prediction_point": "T3M", "model_version": "test-v1",
                                   "pass_mark": 50, "missing_score_policy": "EXCLUDE",
                                   "rows": [{"row_id": 0, "features": student("T3M", 45)}]})
            self.assertEqual(out["evaluation"]["kind"], "pass_mark_rule")
            with self.assertRaises(handler.InputError):
                handler.handler({"action": "counterfactuals", "prediction_point": "T3M", "model_version": "test-v1",
                                 "rows": [{"row_id": 0, "features": student("T3M", 45)}]})
            with self.assertRaises(handler.InputError):
                handler.handler({"action": "counterfactuals", "prediction_point": "T1M", "model_version": "other",
                                 "rows": [{"row_id": 0, "features": student("T1M", 45)}]})

    def test_without_stats_uses_static_caps(self):
        with mock.patch.object(handler.model_store, "load", return_value=FakeModel(with_stats=False)):
            out = handler.handler({"action": "counterfactuals", "prediction_point": "T1M", "model_version": "test-v1",
                                   "rows": [{"row_id": 0, "features": student("T1M", 40, 70)}]})
            self.assertFalse(out["stats"]["available"])
            self.assertTrue(all(c["source"] == "static" for c in out["results"][0]["caps"].values()))


if __name__ == "__main__":
    unittest.main()
