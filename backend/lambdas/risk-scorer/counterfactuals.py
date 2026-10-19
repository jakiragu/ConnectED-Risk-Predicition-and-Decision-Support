"""
Counterfactual targets for a student the current model flags as at risk.

1. Baseline for the next checkpoint. The student's current subject marks and
   attendance are carried forward as a hypothetical next-checkpoint record
   (T1M -> T1F -> T2M -> T2F -> T3M -> T3F). It is not a prediction that the
   student will score the same; a missing result stays missing and nothing is
   invented. Everything before the next checkpoint stays exactly as recorded.
2. What judges the baseline.
     T1M..T2F: the NEXT checkpoint's risk model and its threshold.
     T3M:      the At_Risk rule itself, on the projected Term 3 Final: the
               average of the T3F subject marks is below the school's pass mark.
               The school's missing_score_policy decides how a subject with no
               result enters the average (EXCLUDE: left out; ZERO: counted as 0
               over all nine subjects).
   If the baseline already clears it, the student only needs to keep their
   current results (MAINTAIN).
3. DiCE ("random", seeded) searches upward changes to the next checkpoint's
   marks (and its year-to-date attendance, except at T3M where the rule uses
   marks only) within the permitted-change caps, for a record that is no
   longer at risk. Every option it returns is re-evaluated; only options that
   really clear the model or the rule are kept (FOUND).
4. If DiCE finds no valid option, the peer-progression fallback sets one
   target per changeable result from comparable students' progress (FALLBACK).
   It does not have to clear the model; its projection is reported as it is.

Permitted-change caps (shared by DiCE and the fallback):
  subject     the transition's P90 of positive mark changes in the training data
              (counterfactual-stats.json in the model package); else the static cap
  attendance  the lower of the transition's P95 of positive year-to-date changes
              (else the static cap) and the most the student can reach by the next
              checkpoint by attending every school day of the next period
  never above 100. The static caps are COUNTERFACTUAL_STATIC_MARK_CAP (20) and
  COUNTERFACTUAL_STATIC_ATTENDANCE_CAP (10).

DiCE refuses missing values, so it is shown only the results that may change;
a wrapper puts everything else back (missing values included) before every
evaluation.
"""
import math
import os
import warnings

import numpy as np
import pandas as pd
import xgboost

warnings.filterwarnings("ignore")

DICE = "dice-random"
PEERS = "peer-progression"
OUTCOME = "academic_risk"
SUBJECTS = ["Mathematics", "English", "Kiswahili", "Chemistry", "Biology", "Physics", "History", "Geography", "Religious_Education"]
POINTS = ["T1M", "T1F", "T2M", "T2F", "T3M", "T3F"]
NEXT = {"T1M": "T1F", "T1F": "T2M", "T2M": "T2F", "T2F": "T3M", "T3M": "T3F"}
FINAL = "T3F"
ATTENDANCE = "Attendance"


def settings():
    return {
        "static_mark_cap": float(os.environ.get("COUNTERFACTUAL_STATIC_MARK_CAP", "20")),
        "static_attendance_cap": float(os.environ.get("COUNTERFACTUAL_STATIC_ATTENDANCE_CAP", "10")),
        "options": int(os.environ.get("COUNTERFACTUAL_OPTIONS", "3")),
        "seed": int(os.environ.get("COUNTERFACTUAL_SEED", "20261")),
    }


def is_attendance(column):
    return column.startswith(f"{ATTENDANCE}_")


def group_of(column):
    return ATTENDANCE if is_attendance(column) else column.split("_", 1)[1]


# ---------------------------------------------------------------- baseline


def baseline(point, values):
    """The next checkpoint's record with the current results carried forward (missing stays missing)."""
    nxt = NEXT[point]
    base = {k: v for k, v in values.items()}
    for s in SUBJECTS:
        base[f"{nxt}_{s}"] = values.get(f"{point}_{s}")
    if nxt != FINAL:
        base[f"{ATTENDANCE}_{nxt}"] = values.get(f"{ATTENDANCE}_{point}")
    return base


def average_so_far(point, values):
    """Mean of every subject result recorded up to and including `point` (the peer-group key)."""
    upto = POINTS[: POINTS.index(point) + 1]
    marks = [values.get(f"{p}_{s}") for p in upto for s in SUBJECTS]
    marks = [m for m in marks if m is not None]
    return sum(marks) / len(marks) if marks else None


# ------------------------------------------------------------- evaluators


class ModelEvaluation:
    """The next checkpoint's risk model: at risk when its probability reaches its threshold."""

    kind = "model"

    def __init__(self, point, booster, features, threshold):
        self.point = point
        self.booster = booster
        self.features = features
        self.threshold = threshold

    def scores(self, rows):
        m = np.array([[np.nan if r.get(f) is None else float(r[f]) for f in self.features] for r in rows], dtype=np.float32)
        return [float(x) for x in self.booster.predict(xgboost.DMatrix(m, feature_names=self.features, missing=np.nan))]

    def at_risk(self, score):
        return score >= self.threshold

    def risk_signal(self, score):  # what DiCE sees as the probability of the at-risk class
        return score

    def describe(self):
        return {"kind": self.kind, "model_point": self.point, "threshold": self.threshold, "pass_mark": None, "missing_score_policy": None}


class PassMarkRule:
    """At_Risk on the projected Term 3 Final: the average of the T3F subject marks below the pass mark."""

    kind = "pass_mark_rule"

    def __init__(self, pass_mark, missing_score_policy):
        if pass_mark is None:
            raise ValueError("pass_mark is required at T3M")
        policy = (missing_score_policy or "EXCLUDE").upper()
        if policy not in ("EXCLUDE", "ZERO"):
            raise ValueError(f"missing_score_policy must be EXCLUDE or ZERO, not {missing_score_policy}")
        self.pass_mark = float(pass_mark)
        self.policy = policy
        self.columns = [f"{FINAL}_{s}" for s in SUBJECTS]

    def average(self, row):
        present = [float(row[c]) for c in self.columns if row.get(c) is not None]
        if self.policy == "ZERO":
            return sum(present) / len(self.columns)
        return sum(present) / len(present) if present else None

    def scores(self, rows):
        return [self.average(r) for r in rows]

    def at_risk(self, score):
        return score is None or score < self.pass_mark

    def risk_signal(self, score):
        return 1.0 if self.at_risk(score) else 0.0

    def describe(self):
        return {"kind": self.kind, "model_point": None, "threshold": None, "pass_mark": self.pass_mark, "missing_score_policy": self.policy}


# ------------------------------------------------------------------- caps


def _transition(stats, point):
    return (stats or {}).get("transitions", {}).get(f"{point}>{NEXT[point]}")


def caps(point, base, stats, attendance_context, rules):
    """The permitted change for every result that may move at the next checkpoint; used by DiCE and the fallback alike."""
    nxt = NEXT[point]
    t = _transition(stats, point)
    out = {}
    for s in SUBJECTS:
        col = f"{nxt}_{s}"
        current = base.get(col)
        if current is None:
            continue
        stat = (t or {}).get("caps", {}).get(s)
        increase, source = (float(stat), "data") if stat is not None else (rules["static_mark_cap"], "static")
        out[col] = {"current": float(current), "max_increase": increase, "source": source}
    col = f"{ATTENDANCE}_{nxt}"
    if nxt != FINAL and base.get(col) is not None:
        current = float(base[col])
        stat = (t or {}).get("caps", {}).get(ATTENDANCE)
        increase, source = (float(stat), "data") if stat is not None else (rules["static_attendance_cap"], "static")
        ctx = attendance_context or {}
        attended, counted, days = ctx.get("attended"), ctx.get("counted"), ctx.get("next_school_days")
        ceiling = None
        if attended is not None and counted is not None and days is not None and counted + days > 0:
            ceiling = (float(attended) + float(days)) / (float(counted) + float(days)) * 100
            if ceiling - current < increase:
                increase, source = max(0.0, ceiling - current), "ceiling"
        out[col] = {"current": current, "max_increase": increase, "source": source,
                    "ceiling": round(ceiling, 4) if ceiling is not None else None}
    for c in out.values():
        c["max_value"] = min(100.0, c["current"] + c["max_increase"])
        c["max_increase"] = round(c["max_value"] - c["current"], 4)
        c["max_value"] = round(c["max_value"], 4)
    return out


# --------------------------------------------------------------- rounding


def _floor1(x):
    return math.floor(x * 10 + 1e-9) / 10


def tidy(column, value, limit):
    """Marks up to a whole mark, attendance to one decimal place; never past the cap."""
    if is_attendance(column):
        return min(round(value + 1e-9, 1), _floor1(limit))
    up = float(math.ceil(value - 1e-9))
    return up if up <= limit + 1e-9 else float(math.floor(limit + 1e-9))


# ------------------------------------------------------------------- DiCE


class _Reduced:
    """What DiCE calls: the evaluator over the changeable results, everything else held as in the baseline."""

    def __init__(self, evaluation, base, columns):
        self.evaluation = evaluation
        self.base = base
        self.columns = columns

    def rows(self, frame):
        out = []
        for _, r in frame[self.columns].iterrows():
            row = dict(self.base)
            row.update({c: float(r[c]) for c in self.columns})
            out.append(row)
        return out

    def predict_proba(self, frame):
        signal = np.array([self.evaluation.risk_signal(s) for s in self.evaluation.scores(self.rows(frame))])
        return np.column_stack([1 - signal, signal])

    def predict(self, frame):
        return (self.predict_proba(frame)[:, 1] >= 0.5).astype(int)


def _evaluate(evaluation, base, targets):
    row = dict(base)
    row.update(targets)
    score = evaluation.scores([row])[0]
    return score, evaluation.at_risk(score)


def _prune(evaluation, base, start, target):
    """Drops every change an option does not need, smallest first."""
    changed = sorted((c for c in target if target[c] > start[c] + 1e-9), key=lambda c: target[c] - start[c])
    for c in changed:
        trial = {**target, c: start[c]}
        if not _evaluate(evaluation, base, trial)[1]:
            target = trial
    return target


def _dominated(option, others):
    mine = {ch["feature"]: ch["to"] for ch in option["changes"]}
    for other in others:
        if other is option:
            continue
        theirs = {ch["feature"]: ch["to"] for ch in other["changes"]}
        if theirs != mine and set(theirs) <= set(mine) and all(theirs[f] <= mine[f] for f in theirs):
            return True
    return False


def _option(evaluation, base, start, target, method, extra=None):
    score, risk = _evaluate(evaluation, base, target)
    changes = []
    for c in start:
        if target[c] > start[c] + 1e-9:
            ch = {"feature": c, "from": start[c], "to": target[c]}
            if extra and c in extra:
                ch.update(extra[c])
            changes.append(ch)
    return {"method": method, "score": round(score, 6) if score is not None else None, "at_risk": bool(risk), "changes": changes}


def dice_search(evaluation, base, limits, rules):
    """DiCE within the caps. Returns (options, reason): valid options only."""
    import dice_ml  # scoring alone does not need it

    columns = [c for c, lim in limits.items() if lim["max_value"] > lim["current"] + 1e-9]
    if not columns:
        return [], "No result can be raised within the permitted changes"
    start = {c: limits[c]["current"] for c in columns}
    best = {c: limits[c]["max_value"] for c in columns}
    if _evaluate(evaluation, base, best)[1]:
        return [], "Even the largest permitted changes would leave the student at risk"

    model = _Reduced(evaluation, base, columns)
    ranges = {c: [start[c], limits[c]["max_value"]] for c in columns}
    data = dice_ml.Data(features={c: [lo, hi] for c, (lo, hi) in ranges.items()}, outcome_name=OUTCOME)
    explainer = dice_ml.Dice(data, dice_ml.Model(model=model, backend="sklearn", model_type="classifier"), method="random")
    try:
        found = explainer.generate_counterfactuals(
            pd.DataFrame([start]), total_CFs=rules["options"] * 3, desired_class=0,
            random_seed=rules["seed"], permitted_range=ranges, verbose=False,
        ).cf_examples_list[0].final_cfs_df
    except Exception as e:  # DiCE raises when nothing in the ranges clears the evaluation
        return [], f"DiCE found no counterfactual within the permitted changes ({type(e).__name__})"
    if found is None or found.empty:
        return [], "DiCE found no counterfactual within the permitted changes"

    options, seen = [], set()
    for _, cf in found.iterrows():
        target = {c: (tidy(c, float(cf[c]), limits[c]["max_value"]) if float(cf[c]) > start[c] + 1e-9 else start[c]) for c in columns}
        target = _prune(evaluation, base, start, target)
        key = tuple((c, target[c]) for c in columns if target[c] > start[c] + 1e-9)
        if not key or key in seen:
            continue
        option = _option(evaluation, base, start, target, DICE)
        if option["at_risk"]:  # rounding or a non-monotone region undid it
            continue
        seen.add(key)
        options.append(option)
    options = [o for o in options if not _dominated(o, options)]
    options.sort(key=lambda o: (len(o["changes"]), sum(ch["to"] - ch["from"] for ch in o["changes"])))
    options = options[: rules["options"]]
    return options, (None if options else "DiCE found no counterfactual that clears the evaluation after rounding")


# -------------------------------------------------------- peer progression


def peer_fallback(point, evaluation, base, limits, stats, average):
    """
    One target per changeable result, from comparable students' progress at this transition:
      peer change at the target percentile > 0   current + that change, within the cap
      otherwise, or no usable peer group          current + the cap
    """
    t = _transition(stats, point)
    centre = None if average is None else int(min(100, max(0, round(average))))
    start, target, extra = {}, {}, {}
    for col, lim in limits.items():
        start[col] = lim["current"]
        entry = None
        if t is not None and centre is not None:
            table = t.get("peers", {}).get(group_of(col))
            entry = table[centre] if table else None
        if entry and entry[2] > 0:
            raw, basis = lim["current"] + min(entry[2], lim["max_increase"]), "peer"
        else:
            raw, basis = lim["current"] + lim["max_increase"], "cap"
        raw = min(raw, lim["max_value"])
        target[col] = max(lim["current"], tidy(col, raw, lim["max_value"]))
        extra[col] = {
            "basis": basis,
            "peer": {"window": entry[0], "peers": entry[1], "change": entry[2], "centre": centre} if entry else None,
        }
    option = _option(evaluation, base, start, target, PEERS, extra)
    return option if option["changes"] else None


# ---------------------------------------------------------------- generate


def generate(point, values, evaluation, stats=None, attendance_context=None, rules=None):
    """
    @param point        the student's current prediction point (T1M..T3M)
    @param values       the current point's model inputs {column: number | None}
    @param evaluation   ModelEvaluation for the next checkpoint's model, or PassMarkRule at T3M
    """
    rules = rules or settings()
    base = baseline(point, values)
    limits = caps(point, base, stats, attendance_context, rules)
    base_score = evaluation.scores([base])[0]
    result = {
        "target_point": NEXT[point],
        "evaluation": {**evaluation.describe(), "baseline_score": round(base_score, 6) if base_score is not None else None,
                       "baseline_at_risk": bool(evaluation.at_risk(base_score))},
        "caps": limits,
        "dice": None,
        "options": [],
    }
    if not evaluation.at_risk(base_score):
        return {**result, "status": "MAINTAIN", "method": None,
                "reason": "Keeping the current results and attendance would already clear the next checkpoint"}
    if not limits:
        return {**result, "status": "NONE", "method": None, "reason": "No results at this checkpoint to set a target on"}

    options, why = dice_search(evaluation, base, limits, rules)
    result["dice"] = {"found": bool(options), "reason": why}
    if options:
        return {**result, "status": "FOUND", "method": DICE, "reason": None, "options": options}

    fallback = peer_fallback(point, evaluation, base, limits, stats, average_so_far(point, values))
    if fallback is None:
        return {**result, "status": "NONE", "method": None, "reason": f"{why}; no result can be raised"}
    return {**result, "status": "FALLBACK", "method": PEERS, "reason": why, "options": [fallback]}
