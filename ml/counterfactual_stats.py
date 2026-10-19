"""
Counterfactual statistics for a model package, built offline from the
training partition only (a student-level split, so evaluation students never
contribute). The risk scorer reads them at runtime; it never sees training data.

For each checkpoint transition (T1M>T1F, T1F>T2M, T2M>T2F, T2F>T3M):
  caps   the most a result may be raised for a target:
           subject       P{mark_cap_percentile} (default 90) of the positive mark changes
           Attendance    P{attendance_cap_percentile} (default 95) of the positive changes in
                         year-to-date attendance
  peers  for every whole-mark centre 0-100 of a student's average so far
         (all checkpoints available so far): the window used (+-5 marks,
         widened one mark at a time up to +-15 until at least min_peers
         students fall in it), the group size, and the change at the target
         percentile (default P75) of every observed change, zero and negative
         included. A centre whose widest window still has too few students has
         no usable peer group (null).
T3M>T3F has no training data (there is no T3F snapshot), so it has no caps or
peers; the scorer then uses the static caps.

    python ml/counterfactual_stats.py --data <snapshot folder> --package ml/models/<version> [--version <new version>]

adds the statistics to an existing package (writes counterfactual-stats.json
and records it in manifest.json). A changed manifest needs a new model_version
before publishing. ml/package_xgboost.py calls build() for new packages.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

POINTS = ["T1M", "T1F", "T2M", "T2F", "T3M"]
SUBJECTS = ["Mathematics", "English", "Kiswahili", "Chemistry", "Biology", "Physics", "History", "Geography", "Religious_Education"]
ATTENDANCE = "Attendance"
ID = "student_id"
TARGET = "academic_risk"
SEED = 54321
FILE = "counterfactual-stats.json"

DEFAULTS = {
    "target_percentile": 75,
    "mark_cap_percentile": 90,
    "attendance_cap_percentile": 95,
    "window_start": 5,
    "window_max": 15,
    "min_peers": 30,
}


def training_ids(snapshots, seed=SEED):
    """The packaging script's student-level split: the 80% used to train the models."""
    ids, labels = snapshots["T1M"][ID], snapshots["T1M"][TARGET]
    train, _ = train_test_split(ids, test_size=0.20, random_state=seed, stratify=labels)
    return set(train)


def average_so_far(frame, point):
    """Each student's mean subject result over every checkpoint up to and including `point`."""
    cols = [f"{p}_{s}" for p in POINTS[: POINTS.index(point) + 1] for s in SUBJECTS if f"{p}_{s}" in frame.columns]
    return frame[cols].mean(axis=1, skipna=True)


def _percentile(values, q):
    values = values[~np.isnan(values)]
    return float(np.percentile(values, q)) if len(values) else None


def _peer_table(averages, changes, settings):
    """For each centre 0..100: [window, peers, change at the target percentile] or None."""
    ok = ~np.isnan(averages) & ~np.isnan(changes)
    a, c = averages[ok], changes[ok]
    table = []
    for centre in range(0, 101):
        entry = None
        for window in range(settings["window_start"], settings["window_max"] + 1):
            inside = np.abs(a - centre) <= window
            n = int(inside.sum())
            if n >= settings["min_peers"]:
                entry = [window, n, round(float(np.percentile(c[inside], settings["target_percentile"])), 4)]
                break
        table.append(entry)
    return table


def build(snapshots, train_ids, settings=None):
    settings = {**DEFAULTS, **(settings or {})}
    transitions = {}
    for current, nxt in zip(POINTS, POINTS[1:]):
        frame = snapshots[nxt][snapshots[nxt][ID].isin(train_ids)]  # the later snapshot holds both checkpoints
        averages = average_so_far(frame, current).to_numpy(dtype=float)
        caps, peers = {}, {}
        for subject in SUBJECTS:
            a, b = f"{current}_{subject}", f"{nxt}_{subject}"
            if a not in frame.columns or b not in frame.columns:
                continue
            change = (frame[b] - frame[a]).to_numpy(dtype=float)
            caps[subject] = _percentile(change[change > 0], settings["mark_cap_percentile"])
            peers[subject] = _peer_table(averages, change, settings)
        a, b = f"{ATTENDANCE}_{current}", f"{ATTENDANCE}_{nxt}"
        if a in frame.columns and b in frame.columns:
            change = (frame[b] - frame[a]).to_numpy(dtype=float)
            caps[ATTENDANCE] = _percentile(change[change > 0], settings["attendance_cap_percentile"])
            peers[ATTENDANCE] = _peer_table(averages, change, settings)
        transitions[f"{current}>{nxt}"] = {
            "from": current, "to": nxt, "students": int(len(frame)),
            "caps": {k: (round(v, 4) if v is not None else None) for k, v in caps.items()},
            "peers": peers,
        }
    transitions["T3M>T3F"] = {
        "from": "T3M", "to": "T3F", "students": 0, "caps": {}, "peers": {},
        "note": "No T3F training data: the scorer uses the static caps, and there is no peer group",
    }
    return {
        "version": 1,
        "description": "Permitted-change caps and peer-progression statistics from the training partition",
        "train_students": len(train_ids),
        "settings": settings,
        "transitions": transitions,
    }


def write(package, stats, version=None):
    package = Path(package)
    path = package / FILE
    path.write_text(json.dumps(stats, separators=(",", ":")) + "\n")
    manifest_path = package / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if version:
        manifest["model_version"] = version
    manifest["counterfactual_stats"] = {
        "file": FILE,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "settings": stats["settings"],
        "train_students": stats["train_students"],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="folder with snapshot_T1M.csv ... snapshot_T3M.csv")
    parser.add_argument("--package", required=True, help="model package folder (with manifest.json)")
    parser.add_argument("--version", default=None, help="new model_version for the changed package")
    parser.add_argument("--train-ids", default=None, help="file with one training student_id per line (default: the packaging split)")
    for key, value in DEFAULTS.items():
        parser.add_argument(f"--{key.replace('_', '-')}", type=int, default=value)
    args = parser.parse_args()
    snapshots = {p: pd.read_csv(Path(args.data) / f"snapshot_{p}.csv") for p in POINTS}
    train = set(Path(args.train_ids).read_text().split()) if args.train_ids else training_ids(snapshots)
    settings = {k: getattr(args, k) for k in DEFAULTS}
    stats = build(snapshots, train, settings)
    path = write(args.package, stats, args.version)
    for name, t in stats["transitions"].items():
        caps = ", ".join(f"{k} {v:.1f}" for k, v in t["caps"].items() if v is not None) or "none"
        print(f"{name}: {t['students']} training students; caps: {caps}")
    print(f"\nWrote {path}; manifest.json records it" + (f" (model_version {args.version})" if args.version else ""))


if __name__ == "__main__":
    main()
