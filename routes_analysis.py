"""Spend-history analysis route."""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from analysis import analyze_spend, build_executive_summary_docx, build_spend_analysis_workbook, parse_spend_file
from engine import engine

router = APIRouter()


@router.post("/analysis/spend/")
async def spend_analysis(
    file: UploadFile = File(...),
    recommended_tier: str = Form("best"),
):
    """
    Ingest historical spend data (date, location, product, quantity, and
    unit_price or total_price - optionally competitor_uses_per_case) and
    generate a usage analysis workbook plus an executive summary document
    showing how much switching to Office Basics equivalents would have saved.
    """
    if not engine.catalog:
        raise HTTPException(400, "No Office Basics catalog loaded. POST one to /catalog/upload/ first.")

    content = await file.read()
    ext = file.filename.lower().split(".")[-1]
    df = parse_spend_file(content, ext)
    analysis = analyze_spend(df, recommended_tier)

    xlsx_filename = build_spend_analysis_workbook(analysis)
    docx_filename = build_executive_summary_docx(analysis)

    return {
        "summary": {k: v for k, v in analysis.items() if k != "detail"},
        "workbook_url": f"/reports/{xlsx_filename}",
        "executive_summary_url": f"/reports/{docx_filename}",
    }
