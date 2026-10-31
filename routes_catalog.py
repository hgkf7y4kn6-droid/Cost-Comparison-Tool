"""Catalog upload and status."""
import io

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile

from config import VALID_TIERS
from engine import engine, feedback_store
from extraction import OCR_AVAILABLE

router = APIRouter()


@router.post("/catalog/upload/")
async def upload_catalog(file: UploadFile = File(...)):
    """
    Ingest the Office Basics SKU/price file.
    Required columns (case-insensitive): sku, name, description, category, tier, price
    Optional columns: format, uses_per_case
    tier must be one of: good, better, best (other rows are kept out of matching but not rejected)
    """
    content = await file.read()
    ext = file.filename.lower().split(".")[-1]
    if ext not in {"xlsx", "xls", "csv"}:
        raise HTTPException(400, "Catalog file must be .xlsx, .xls, or .csv")

    df = pd.read_csv(io.BytesIO(content)) if ext == "csv" else pd.read_excel(io.BytesIO(content))
    df.columns = [c.strip().lower() for c in df.columns]

    required = {"sku", "name", "description", "category", "tier", "price"}
    missing = required - set(df.columns)
    if missing:
        raise HTTPException(422, f"Catalog file missing columns: {sorted(missing)}")

    items = []
    skipped = 0
    for _, row in df.iterrows():
        tier = str(row["tier"]).strip().lower()
        if tier not in VALID_TIERS:
            skipped += 1
            continue
        try:
            price = float(row["price"])
        except (ValueError, TypeError):
            skipped += 1
            continue

        uses_per_case = None
        if "uses_per_case" in df.columns:
            try:
                raw = row["uses_per_case"]
                if pd.notna(raw) and str(raw).strip() not in {"", "TBD"}:
                    uses_per_case = float(raw)
            except (ValueError, TypeError):
                uses_per_case = None

        fmt = None
        if "format" in df.columns and pd.notna(row["format"]):
            fmt = str(row["format"]).strip()

        items.append(
            {
                "sku": str(row["sku"]),
                "name": str(row["name"]),
                "description": str(row["description"]),
                "category": str(row["category"]).strip().lower(),
                "tier": tier,
                "price": price,
                "uses_per_case": uses_per_case,
                "format": fmt,
            }
        )

    if not items:
        raise HTTPException(422, "No valid rows found (check tier values are good/better/best and price is numeric).")

    engine.load_catalog(items)
    return {
        "loaded_items": len(items),
        "skipped_rows": skipped,
        "categories": sorted({i["category"] for i in items}),
    }


@router.get("/catalog/status/")
async def catalog_status():
    return {
        "loaded_items": len(engine.catalog),
        "categories": sorted({i["category"] for i in engine.catalog}),
        "learned_comparisons": len(feedback_store.entries),
        "ocr_available": OCR_AVAILABLE,
    }
