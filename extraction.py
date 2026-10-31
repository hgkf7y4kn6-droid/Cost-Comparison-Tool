"""Text and price extraction from uploaded photos, PDFs and spreadsheets (no ML dependencies)."""
import io
import re
from typing import Optional

import pandas as pd
import pdfplumber
from PIL import Image
from fastapi import HTTPException

try:
    import pytesseract

    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False


PRICE_PATTERN = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)")
PRICE_KEYWORDS = ["price", "cost", "total", "unit price", "each", "$/unit", "list price"]


def extract_price(text: str) -> Optional[float]:
    matches = PRICE_PATTERN.findall(text)
    if not matches:
        return None
    return float(matches[0].replace(",", ""))


def extract_price_near_keywords(text: str) -> Optional[float]:
    for line in text.splitlines():
        if any(k in line.lower() for k in PRICE_KEYWORDS):
            price = extract_price(line)
            if price is not None:
                return price
    return extract_price(text)


def extract_text_and_image(content: bytes, ext: str):
    text = ""
    image = None

    if ext in {"png", "jpg", "jpeg", "webp"}:
        image = Image.open(io.BytesIO(content)).convert("RGB")
        if OCR_AVAILABLE:
            try:
                text = pytesseract.image_to_string(image)
            except Exception:
                text = ""

    elif ext == "pdf":
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            text = " ".join(p.extract_text() or "" for p in pdf.pages)
            if not text.strip() and OCR_AVAILABLE and pdf.pages:
                rendered = pdf.pages[0].to_image(resolution=200).original
                image = rendered.convert("RGB")
                text = pytesseract.image_to_string(image)

    elif ext in {"xlsx", "xls"}:
        df = pd.read_excel(io.BytesIO(content))
        text = " ".join(df.fillna("").astype(str).values.flatten())

    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file format: .{ext}")

    return text, image


def cost_per_use(price: Optional[float], uses_per_case: Optional[float]) -> Optional[float]:
    if price is None or not uses_per_case:
        return None
    return price / uses_per_case
