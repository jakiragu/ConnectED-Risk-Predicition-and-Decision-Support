"""
Where the scorer's models come from: the model bucket (MODEL_BUCKET), the same
way locally (MinIO / s3rver) and on AWS (S3).

    models/current.json                  {"model_version": "...", "prefix": "models/<version>/"}
    models/<version>/manifest.json       per point: file, features, threshold
    models/<version>/<point>.json        XGBoost model in its portable JSON format
    models/<version>/counterfactual-stats.json   optional: permitted-change caps and peer
                                         statistics for counterfactual targets

A model is replaced by publishing a new version and moving current.json to it
(local/publish-model.js). Loaded models are cached per warm Lambda; the pointer
is re-read at most every POINTER_TTL seconds, so a replacement takes effect
within that time without a redeploy.
"""
import hashlib
import json
import os
import time

import boto3
import xgboost
from botocore.config import Config
from botocore.exceptions import ClientError

POINTER_KEY = "models/current.json"
POINTER_TTL = int(os.environ.get("MODEL_POINTER_TTL_SECONDS", "60"))

_s3 = None
_pointer = {"value": None, "read_at": 0.0}
_versions = {}


def s3():
    global _s3
    if _s3 is None:
        endpoint = os.environ.get("S3_ENDPOINT") or None
        _s3 = boto3.client(
            "s3",
            region_name=os.environ.get("AWS_REGION", "eu-west-1"),
            endpoint_url=endpoint,
            config=Config(s3={"addressing_style": "path"}) if endpoint else None,
        )
    return _s3


def _bucket():
    bucket = os.environ.get("MODEL_BUCKET")
    if not bucket:
        raise RuntimeError("MODEL_BUCKET is not set")
    return bucket


def _get(key):
    return s3().get_object(Bucket=_bucket(), Key=key)["Body"].read()


def current_version():
    now = time.time()
    if _pointer["value"] is None or now - _pointer["read_at"] > POINTER_TTL:
        try:
            _pointer["value"] = json.loads(_get(POINTER_KEY))
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NoSuchBucket"):
                raise RuntimeError("No risk model has been published yet (models/current.json is missing)") from e
            raise
        _pointer["read_at"] = now
    return _pointer["value"]


class LoadedModel:
    """One published model version: its manifest and a booster per prediction point."""

    def __init__(self, version, prefix):
        self.version = version
        self.prefix = prefix
        self.manifest = json.loads(_get(f"{prefix}manifest.json"))
        if self.manifest.get("model_version") != version:
            raise RuntimeError(f"manifest says {self.manifest.get('model_version')}, expected {version}")
        self.boosters = {}
        self._stats = None
        self._stats_loaded = False

    def counterfactual_stats(self):
        """The package's counterfactual statistics, or None when it has none (static caps, no peers)."""
        if not self._stats_loaded:
            spec = self.manifest.get("counterfactual_stats")
            if spec:
                raw = _get(f"{self.prefix}{spec['file']}")
                if spec.get("sha256") and hashlib.sha256(raw).hexdigest() != spec["sha256"]:
                    raise RuntimeError(f"{spec['file']} does not match the checksum in the manifest")
                self._stats = json.loads(raw)
            self._stats_loaded = True
        return self._stats

    def point(self, point):
        spec = self.manifest["points"].get(point)
        if spec is None:
            raise RuntimeError(f"model {self.version} has no model for prediction point {point}")
        return spec

    def booster(self, point):
        if point not in self.boosters:
            spec = self.point(point)
            raw = _get(f"{self.prefix}{spec['file']}")
            if spec.get("sha256") and hashlib.sha256(raw).hexdigest() != spec["sha256"]:
                raise RuntimeError(f"{spec['file']} does not match the checksum in the manifest")
            booster = xgboost.Booster()
            booster.load_model(bytearray(raw))
            if booster.feature_names and list(booster.feature_names) != list(spec["features"]):
                raise RuntimeError(f"{point}: the model's feature names do not match the manifest")
            if booster.num_features() != len(spec["features"]):
                raise RuntimeError(f"{point}: the model expects {booster.num_features()} features, the manifest lists {len(spec['features'])}")
            self.boosters[point] = booster
        return self.boosters[point]


def load(version=None):
    """The current model, or a named version (for self-tests before it becomes current)."""
    if version is None:
        pointer = current_version()
        version, prefix = pointer["model_version"], pointer["prefix"]
    else:
        prefix = f"models/{version}/"
    if version not in _versions:
        _versions[version] = LoadedModel(version, prefix)
    return _versions[version]