"""Lead file parsing (Prospecting tab)."""
from fastapi import APIRouter, File, HTTPException, UploadFile

from extraction import OCR_AVAILABLE, pytesseract
from table_extract import extract_sheets

router = APIRouter()


MAX_LEAD_FILE_BYTES = 15 * 1024 * 1024


@router.post("/leads/parse/")
async def parse_lead_file(file: UploadFile = File(...)):
    """
    Read an Excel workbook (.xlsx/.xls) or PDF into rows of text cells so the
    Prospecting tab can preview it and map columns to lead fields. Nothing is
    stored. Returns {"sheets": [{"name", "kind", "rows", "note"}]}; see
    table_extract.py for what each kind means.
    """
    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in {"xlsx", "xls", "pdf"}:
        raise HTTPException(400, "Lead files must be .xlsx, .xls or .pdf (CSV is read in the browser).")
    content = await file.read()
    if len(content) > MAX_LEAD_FILE_BYTES:
        raise HTTPException(413, "File is larger than 15 MB. Split it or export just the rows you need.")
    try:
        sheets = extract_sheets(content, ext, pytesseract if OCR_AVAILABLE else None)
    except Exception as e:  # corrupt, password-protected, or not really that format
        raise HTTPException(422, f"Could not read this .{ext} file: {e}") from e
    if not sheets:
        if ext == "pdf":
            raise HTTPException(
                422,
                "No text found in this PDF. It's probably a scanned image"
                + ("" if OCR_AVAILABLE else " and OCR isn't installed on the server")
                + ". Export the list from its source as Excel/CSV instead.",
            )
        raise HTTPException(422, "The workbook has no data in any sheet.")
    return {"sheets": sheets}
