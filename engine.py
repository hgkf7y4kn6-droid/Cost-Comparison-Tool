"""CLIP + FAISS product matching, the learned-feedback store, and the shared tier-resolution logic."""
import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import faiss
import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

from config import FEEDBACK_PATH, FEEDBACK_SIMILARITY_THRESHOLD, OFFICEBASICS_PORTAL_URL

class CLIPSearchEngine:
    def __init__(self, model_name: str = "openai/clip-vit-base-patch32"):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = CLIPModel.from_pretrained(model_name).to(self.device)
        self.processor = CLIPProcessor.from_pretrained(model_name)
        self.dimension = 512
        self.index = faiss.IndexFlatIP(self.dimension)
        self.catalog: List[Dict[str, Any]] = []
        self.by_sku: Dict[str, Dict[str, Any]] = {}

    def embed_image(self, image: Image.Image) -> np.ndarray:
        inputs = self.processor(images=image, return_tensors="pt").to(self.device)
        with torch.no_grad():
            features = self.model.get_image_features(**inputs)
        vec = features.cpu().numpy().astype("float32")
        faiss.normalize_L2(vec)
        return vec

    def embed_text(self, text: str) -> np.ndarray:
        inputs = self.processor(
            text=[text], return_tensors="pt", padding=True, truncation=True
        ).to(self.device)
        with torch.no_grad():
            features = self.model.get_text_features(**inputs)
        vec = features.cpu().numpy().astype("float32")
        faiss.normalize_L2(vec)
        return vec

    def load_catalog(self, items: List[Dict[str, Any]]):
        """Each item must have: sku, name, description, category, tier, price.
        Optional: format, uses_per_case."""
        self.catalog = items
        self.by_sku = {it["sku"]: it for it in items}
        self.index = faiss.IndexFlatIP(self.dimension)
        if not items:
            return
        vectors = [
            self.embed_text(f"{it['name']} - {it['description']}")[0] for it in items
        ]
        self.index.add(np.array(vectors).astype("float32"))

    def search(self, vector: np.ndarray, top_k: int = 30) -> List[Dict[str, Any]]:
        if self.index.ntotal == 0:
            return []
        top_k = min(top_k, self.index.ntotal)
        scores, indices = self.index.search(vector, top_k)
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx != -1:
                item = self.catalog[idx].copy()
                item["similarity_score"] = float(score)
                results.append(item)
        return results


class FeedbackStore:
    """
    Remembers which SKUs a rep confirmed as the good/better/best match for a
    given competitor product. Future uploads of a visually/textually similar
    competitor product retrieve this confirmed mapping instead of recomputing
    from scratch.
    """

    def __init__(self, engine: CLIPSearchEngine, path: str = FEEDBACK_PATH):
        self.engine = engine
        self.path = path
        self.entries: List[Dict[str, Any]] = []
        self.index = faiss.IndexFlatIP(engine.dimension)
        self._load()

    def _load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path) as f:
                    self.entries = json.load(f)
            except (json.JSONDecodeError, OSError):
                self.entries = []
        self.index = faiss.IndexFlatIP(self.engine.dimension)
        if self.entries:
            vectors = np.array([e["vector"] for e in self.entries]).astype("float32")
            self.index.add(vectors)

    def _save(self):
        with open(self.path, "w") as f:
            json.dump(self.entries, f)

    def add(self, vector: np.ndarray, competitor_name: str, tier_skus: Dict[str, str]):
        entry = {
            "vector": vector[0].tolist(),
            "competitor_name": competitor_name,
            "tier_skus": tier_skus,
            "confirmed_at": datetime.now().isoformat(),
        }
        self.entries.append(entry)
        self.index.add(vector.astype("float32"))
        self._save()

    def lookup(self, vector: np.ndarray, threshold: float = FEEDBACK_SIMILARITY_THRESHOLD) -> Optional[Dict[str, Any]]:
        if self.index.ntotal == 0:
            return None
        scores, indices = self.index.search(vector.astype("float32"), 1)
        score, idx = float(scores[0][0]), int(indices[0][0])
        if idx == -1 or score < threshold:
            return None
        return {"match_score": score, **self.entries[idx]}
engine = CLIPSearchEngine()
feedback_store = FeedbackStore(engine)

# in-memory cache of pending (unconfirmed) comparisons, keyed by comparison_id,
# so /feedback/confirm/ doesn't require re-uploading the file. Bounded so a
# long-running process can't accumulate this without limit - old, never-
# confirmed comparisons are simply no longer confirmable, which only means
# the rep has to re-run /compare/ before confirming.
PENDING_COMPARISONS_MAX = 2000
PENDING_COMPARISONS: Dict[str, Dict[str, Any]] = {}


def _remember_pending_comparison(comparison_id: str, payload: Dict[str, Any]) -> None:
    if len(PENDING_COMPARISONS) >= PENDING_COMPARISONS_MAX:
        oldest_id = next(iter(PENDING_COMPARISONS))
        del PENDING_COMPARISONS[oldest_id]
    PENDING_COMPARISONS[comparison_id] = payload


def resolve_tiers(vec: np.ndarray) -> Dict[str, Any]:
    """
    Shared matching core used by both single-item comparisons and the spend
    analysis: checks the learned feedback store first, then falls back to
    algorithmic category + per-tier similarity ranking for anything missing.
    """
    tiers: Dict[str, Dict[str, Any]] = {}
    source = "algorithmic"
    matched_category = None
    match_score = None

    learned = feedback_store.lookup(vec)
    if learned:
        source = "learned"
        match_score = learned["match_score"]
        for tier_name, sku in learned["tier_skus"].items():
            item = engine.by_sku.get(sku)
            if item:
                tiers[tier_name] = {k: v for k, v in item.items() if k != "similarity_score"}
                matched_category = matched_category or item["category"]

    if len(tiers) < 3:
        matches = engine.search(vec, top_k=30)
        if matches:
            top_category = matched_category or matches[0]["category"]
            same_category = [m for m in matches if m["category"] == top_category]
            for tier_name in ["good", "better", "best"]:
                if tier_name in tiers:
                    continue
                candidates = [m for m in same_category if m["tier"] == tier_name]
                if candidates:
                    best = max(candidates, key=lambda x: x["similarity_score"])
                    tiers[tier_name] = {k: v for k, v in best.items() if k != "similarity_score"}
            matched_category = matched_category or top_category

    return {
        "tiers": tiers,
        "matched_category": matched_category,
        "source": source,
        "match_score": match_score,
    }


def manual_lookup_hint(tiers: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    supplies.officebasics.com is a login-gated B2B portal (per-account contract
    pricing, JS-rendered) and cannot be searched or scraped automatically. When
    a tier is missing from the catalog match, surface a manual-lookup pointer
    instead of silently failing or fabricating a result.
    """
    missing = [t for t in ["good", "better", "best"] if t not in tiers]
    if not missing:
        return None
    return {
        "missing_tiers": missing,
        "note": (
            f"No catalog match yet for: {', '.join(missing)}. supplies.officebasics.com "
            "requires an account login and can't be searched automatically - check it "
            "manually there until more catalog items are uploaded."
        ),
        "portal_url": OFFICEBASICS_PORTAL_URL,
    }
