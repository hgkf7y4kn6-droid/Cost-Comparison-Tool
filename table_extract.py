"""Turn uploaded Excel workbooks and PDFs into plain rows of text cells.

Used by the Prospecting tab's lead import (POST /leads/parse/). The frontend
shows the result for review and lets the rep map columns to lead fields, so
this module only has to find the tables. It never guesses what the columns
mean.

Each returned "sheet" is {"name", "kind", "rows", "note"}, with kind one of:
- "sheet": a worksheet from an Excel file
- "table": a ruled table pdfplumber detected in a PDF, merged across pages
  when the column count stays the same
- "aligned": columns inferred from where text phrases start on the page, for
  tables drawn without ruling lines
- "records": directory-style listings (name / address / phone on separate
  lines), one row per entry, split wherever the line spacing widens
- "text": every text line, split into cells at wide gaps
- "ocr": text lines from OCR of a scanned PDF with no text layer
"""
import io
import re
import statistics
from typing import Any, Dict, List, Optional

import pandas as pd
import pdfplumber

MAX_ROWS = 20000  # per sheet
MAX_PDF_PAGES = 200
MAX_OCR_PAGES = 15

LINE_TOLERANCE = 3  # points: words this close vertically share a line
COLUMN_TOLERANCE = 6  # points: phrase starts this close share a column

Rows = List[List[str]]


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _tidy(rows: Rows) -> Rows:
    """Drop empty rows and columns and pad every row to the same width."""
    rows = [[_clean(c) for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return []
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    keep = [i for i in range(width) if any(r[i] for r in rows)]
    return [[r[i] for i in keep] for r in rows]


def _sheet(name: str, kind: str, rows: Rows, note: str = "") -> Dict[str, Any]:
    if len(rows) > MAX_ROWS:
        note = (note + " " if note else "") + f"Only the first {MAX_ROWS:,} of {len(rows):,} rows are included."
        rows = rows[:MAX_ROWS]
    return {"name": name, "kind": kind, "rows": rows, "note": note}


# --- Excel -------------------------------------------------------------------

def excel_sheets(content: bytes) -> List[Dict[str, Any]]:
    frames = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, dtype=str)
    sheets = []
    for name, df in frames.items():
        rows = _tidy(df.fillna("").values.tolist())
        if rows:
            sheets.append(_sheet(str(name), "sheet", rows))
    return sheets


# --- PDF ---------------------------------------------------------------------

def _ruled_tables(pdf) -> List[Dict[str, Any]]:
    groups: List[Dict[str, Any]] = []
    for page_no, page in enumerate(pdf.pages[:MAX_PDF_PAGES], start=1):
        for table in page.extract_tables():
            rows = _tidy(table)
            if len(rows) < 2 or len(rows[0]) < 2:
                continue
            last = groups[-1] if groups else None
            # A table continuing onto the next page: same width, adjacent page.
            if last and len(last["rows"][0]) == len(rows[0]) and page_no - last["last_page"] <= 1:
                if rows[0] == last["rows"][0]:
                    rows = rows[1:]  # header repeated on each page
                last["rows"].extend(rows)
                last["last_page"] = page_no
            else:
                groups.append({"rows": rows, "first_page": page_no, "last_page": page_no})
    return groups


def _page_lines(page, page_no: int) -> List[Dict[str, Any]]:
    """Text lines on a page, each split into phrases at gaps wider than a space."""
    words = sorted(page.extract_words(x_tolerance=1.5, y_tolerance=LINE_TOLERANCE),
                   key=lambda w: (w["top"], w["x0"]))
    raw: List[List[Dict[str, Any]]] = []
    for w in words:
        if raw and abs(w["top"] - raw[-1][0]["top"]) <= LINE_TOLERANCE:
            raw[-1].append(w)
        else:
            raw.append([w])
    lines = []
    for ws in raw:
        ws.sort(key=lambda w: w["x0"])
        phrases: List[Dict[str, Any]] = []
        for w in ws:
            height = w["bottom"] - w["top"]
            # A normal space is ~0.25-0.3 em; anything wider is a column gap.
            if phrases and w["x0"] - phrases[-1]["x1"] <= max(2.5, 0.5 * height):
                phrases[-1]["text"] += " " + w["text"]
                phrases[-1]["x1"] = w["x1"]
            else:
                phrases.append({"text": w["text"], "x0": w["x0"], "x1": w["x1"]})
        lines.append({"page": page_no, "top": ws[0]["top"], "phrases": phrases})
    return lines


def _aligned_table(lines: List[Dict[str, Any]]) -> Rows:
    """Columns = phrase start positions shared by many lines."""
    multi = [ln for ln in lines if len(ln["phrases"]) >= 2]
    if len(multi) < 2:
        return []
    xs = sorted(p["x0"] for ln in multi for p in ln["phrases"])
    clusters: List[List[float]] = []
    for x in xs:
        if clusters and x - clusters[-1][-1] <= COLUMN_TOLERANCE:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    needed = max(2, 0.3 * len(multi))
    anchors = [c[0] for c in clusters if len(c) >= needed]
    if len(anchors) < 2:
        return []
    rows = []
    for ln in multi:
        row = [""] * len(anchors)
        for p in ln["phrases"]:
            col = max((i for i, a in enumerate(anchors) if a <= p["x0"] + COLUMN_TOLERANCE), default=0)
            row[col] = f"{row[col]} {p['text']}".strip()
        rows.append(row)
    return rows


def _records(lines: List[Dict[str, Any]]) -> Rows:
    """Group consecutive lines into entries wherever the line spacing widens."""
    gaps = [b["top"] - a["top"] for a, b in zip(lines, lines[1:]) if a["page"] == b["page"]]
    if len(gaps) < 3:
        return []
    typical = statistics.median(gaps)
    groups = [[lines[0]]]
    for a, b in zip(lines, lines[1:]):
        if b["page"] != a["page"] or b["top"] - a["top"] > 1.4 * typical:
            groups.append([b])
        else:
            groups[-1].append(b)
    sizes = sorted(len(g) for g in groups)
    median_size = sizes[len(sizes) // 2]
    # Real directories: several entries of a few lines each. A table's title
    # gap would otherwise yield one huge "entry", and single-line entries are
    # already covered by the aligned/text views.
    if len(groups) < 3 or median_size < 2 or median_size > 8:
        return []
    return [[p["text"] for ln in g for p in ln["phrases"]] for g in groups]


def _split_lines(text: str) -> Rows:
    rows = []
    for line in text.splitlines():
        cells = [c for c in re.split(r"\s{2,}|\t", line.strip()) if c.strip()]
        if cells:
            rows.append(cells)
    return rows


def _page_label(first: int, last: int) -> str:
    return f"page {first}" if first == last else f"pages {first}–{last}"


def pdf_sheets(content: bytes, ocr=None) -> List[Dict[str, Any]]:
    """`ocr` is pytesseract (or None when OCR isn't installed)."""
    sheets: List[Dict[str, Any]] = []
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        pages = pdf.pages[:MAX_PDF_PAGES]
        truncated = len(pdf.pages) > MAX_PDF_PAGES

        tables = _ruled_tables(pdf)
        for n, g in enumerate(tables, start=1):
            label = f"Table {n} ({_page_label(g['first_page'], g['last_page'])})"
            sheets.append(_sheet(label, "table", _tidy(g["rows"]), "Detected from the table's ruling lines."))

        lines = [ln for i, page in enumerate(pages, start=1) for ln in _page_lines(page, i)]
        if lines and not tables:
            aligned = _tidy(_aligned_table(lines))
            if len(aligned) >= 2:
                sheets.append(_sheet("Columns from text alignment", "aligned", aligned,
                                     "Columns inferred from where text starts on the page; check they line up."))
        if lines:
            records = _tidy(_records(lines))
            if records:
                sheets.append(_sheet("Directory entries (one per block)", "records", records,
                                     "Each entry (name, address, phone… on separate lines) becomes one row."))
            text_rows = _tidy([[p["text"] for p in ln["phrases"]] for ln in lines])
            sheets.append(_sheet("All text lines", "text", text_rows,
                                 "Every line of the PDF, split into columns at wide gaps."))
        elif ocr is not None and pages:
            ocr_rows: Rows = []
            for page in pages[:MAX_OCR_PAGES]:
                image = page.to_image(resolution=250).original.convert("RGB")
                ocr_rows.extend(_split_lines(ocr.image_to_string(image, config="--psm 6")))
            if ocr_rows:
                note = "Scanned PDF read with OCR. Check names, emails and numbers carefully."
                if len(pages) > MAX_OCR_PAGES:
                    note += f" Only the first {MAX_OCR_PAGES} pages were read."
                sheets.append(_sheet("OCR text (scanned PDF)", "ocr", _tidy(ocr_rows), note))

    if truncated:
        for s in sheets:
            s["note"] = (s["note"] + " " if s["note"] else "") + f"Only the first {MAX_PDF_PAGES} pages were read."
    return sheets


def extract_sheets(content: bytes, ext: str, ocr=None) -> List[Dict[str, Any]]:
    if ext in {"xlsx", "xls"}:
        return excel_sheets(content)
    if ext == "pdf":
        return pdf_sheets(content, ocr)
    raise ValueError(f"Unsupported file type: .{ext}")
