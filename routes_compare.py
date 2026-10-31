"""Single-item comparison and learned-feedback routes."""
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from comparison import build_comparison_workbook
from engine import PENDING_COMPARISONS, _remember_pending_comparison, engine, feedback_store, manual_lookup_hint, resolve_tiers
from extraction import cost_per_use, extract_price_near_keywords, extract_text_and_image

router = APIRouter()


async def _run_comparison(
    file: UploadFile, competitor_uses_per_case: Optional[float] = None
) -> Dict[str, Any]:
    if not engine.catalog:
        raise HTTPException(400, "No Office Basics catalog loaded. POST one to /catalog/upload/ first.")

    filename = file.filename.lower()
    ext = filename.split(".")[-1]
    content = await file.read()
    text, image = extract_text_and_image(content, ext)

    competitor_price = extract_price_near_keywords(text)

    if image is not None and ext in {"png", "jpg", "jpeg", "webp"}:
        vec = engine.embed_image(image)
    else:
        if not text.strip():
            raise HTTPException(422, "Could not extract any text from the document.")
        vec = engine.embed_text(text[:800])

    competitor_name = filename
    for line in text.splitlines():
        if line.strip():
            competitor_name = line.strip()[:120]
            break

    resolved = resolve_tiers(vec)
    competitor_cpu = cost_per_use(competitor_price, competitor_uses_per_case)

    comparison_id = str(uuid.uuid4())
    result = {
        "comparison_id": comparison_id,
        "competitor_product": competitor_name,
        "competitor_price": competitor_price,
        "competitor_uses_per_case": competitor_uses_per_case,
        "competitor_cost_per_use": competitor_cpu,
        "matched_category": resolved["matched_category"],
        "source": resolved["source"],
        "match_score": resolved["match_score"],
        "tiers": resolved["tiers"],
        "manual_lookup": manual_lookup_hint(resolved["tiers"]),
    }

    _remember_pending_comparison(comparison_id, {
        "vector": vec,
        "competitor_name": competitor_name,
        "suggested_tier_skus": {t: v["sku"] for t, v in resolved["tiers"].items()},
    })

    return result


@router.post("/compare/")
async def compare_product(
    file: UploadFile = File(...),
    competitor_uses_per_case: Optional[float] = Form(None),
):
    """Returns the good/better/best match JSON without generating a file."""
    return await _run_comparison(file, competitor_uses_per_case)


@router.post("/compare/download/")
async def compare_and_download(
    file: UploadFile = File(...),
    competitor_uses_per_case: Optional[float] = Form(None),
):
    """Runs the comparison and generates a downloadable Excel cost-comparison report."""
    comparison = await _run_comparison(file, competitor_uses_per_case)
    filename = build_comparison_workbook(comparison)
    return {"comparison": comparison, "download_url": f"/reports/{filename}"}


class ConfirmFeedbackRequest(BaseModel):
    comparison_id: str
    good_sku: Optional[str] = None
    better_sku: Optional[str] = None
    best_sku: Optional[str] = None


@router.post("/feedback/confirm/")
async def confirm_feedback(payload: ConfirmFeedbackRequest):
    """
    Records which SKUs actually got used for a given competitor product.
    Only the tiers explicitly passed are overridden; anything left blank
    keeps the tier the comparison originally suggested. Future uploads of a
    similar-looking competitor product will retrieve this confirmed mapping.
    """
    pending = PENDING_COMPARISONS.get(payload.comparison_id)
    if not pending:
        raise HTTPException(404, "Unknown or expired comparison_id. Re-run /compare/ first.")

    overrides = {
        "good": payload.good_sku,
        "better": payload.better_sku,
        "best": payload.best_sku,
    }
    final_tier_skus = dict(pending["suggested_tier_skus"])
    for tier, sku in overrides.items():
        if sku:
            if sku not in engine.by_sku:
                raise HTTPException(422, f"SKU '{sku}' not found in loaded catalog.")
            final_tier_skus[tier] = sku

    if not final_tier_skus:
        raise HTTPException(422, "No tier/SKU information available to confirm.")

    feedback_store.add(pending["vector"], pending["competitor_name"], final_tier_skus)
    return {"status": "confirmed", "competitor_name": pending["competitor_name"], "tier_skus": final_tier_skus}


@router.get("/feedback/list/")
async def list_feedback():
    return {
        "count": len(feedback_store.entries),
        "entries": [
            {
                "competitor_name": e["competitor_name"],
                "tier_skus": e["tier_skus"],
                "confirmed_at": e["confirmed_at"],
            }
            for e in feedback_store.entries
        ],
    }
