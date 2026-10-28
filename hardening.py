"""Request and file safety helpers for the backend.

Kept separate from backend.py (which loads the CLIP model at import) so they
can be unit-tested on their own.

- read_upload():      size cap, extension allow-list and file-signature check
- read_json_limited(): JSON bodies with a size cap
- run_heavy():        bounded concurrency + timeout for parsing/report work
- neutralize_formulas(): turns formula-looking text in generated workbooks into plain text
- security_headers(): headers added to every response
"""
import asyncio
import io
import json
import logging
import os
import threading
import zipfile
from typing import Dict, Iterable, Optional, Tuple

from fastapi import HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool

log = logging.getLogger("saleshub")

MAX_UPLOAD_BYTES = int(float(os.environ.get("MAX_UPLOAD_MB", "15")) * 1024 * 1024)
MAX_JSON_BYTES = int(float(os.environ.get("MAX_JSON_MB", "25")) * 1024 * 1024)
MAX_UNCOMPRESSED_XLSX_BYTES = 250 * 1024 * 1024  # zip-bomb guard
MAX_COMPARE_PDF_PAGES = 30
HEAVY_TIMEOUT_SECONDS = float(os.environ.get("HEAVY_TIMEOUT_SECONDS", "90"))
HEAVY_SLOTS = threading.BoundedSemaphore(int(os.environ.get("HEAVY_CONCURRENCY", "2")))

# First bytes that identify each format (the extension alone is attacker-controlled).
SIGNATURES: Dict[str, Tuple[bytes, ...]] = {
    "xlsx": (b"PK\x03\x04",),
    "xls": (b"\xd0\xcf\x11\xe0", b"PK\x03\x04"),  # some ".xls" exports are really xlsx
    "pdf": (b"%PDF",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
    "webp": (b"RIFF",),
}


def extension_of(filename: Optional[str]) -> str:
    name = os.path.basename((filename or "").replace("\\", "/")).lower()
    return name.rsplit(".", 1)[-1] if "." in name else ""


def _looks_like_text(content: bytes) -> bool:
    if b"\x00" in content[:8192]:
        return False
    try:
        content[:65536].decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            content[:65536].decode("latin-1")
        except UnicodeDecodeError:  # pragma: no cover - latin-1 decodes anything
            return False
    return True


def check_signature(content: bytes, ext: str) -> bool:
    if ext == "csv":
        return _looks_like_text(content)
    sigs = SIGNATURES.get(ext)
    if sigs is None:
        return False
    if not any(content.startswith(s) for s in sigs):
        return False
    if ext == "webp" and content[8:12] != b"WEBP":
        return False
    return True


def check_zip_safe(content: bytes) -> None:
    """Rejects spreadsheets whose contents would expand to an unreasonable size."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            total = sum(i.file_size for i in z.infolist())
    except zipfile.BadZipFile as e:
        raise HTTPException(422, "This isn't a valid Excel file.") from e
    if total > MAX_UNCOMPRESSED_XLSX_BYTES:
        raise HTTPException(413, "This spreadsheet is too large to process. Export only the rows you need.")


async def read_upload(
    file: Optional[UploadFile], allowed: Iterable[str], max_bytes: int = MAX_UPLOAD_BYTES
) -> Tuple[bytes, str]:
    """Reads an upload fully but never more than max_bytes; returns (content, extension)."""
    allowed = set(allowed)
    if file is None or not file.filename:
        raise HTTPException(400, "Choose a file to upload.")
    ext = extension_of(file.filename)
    if ext not in allowed:
        raise HTTPException(400, "Unsupported file type. Allowed: " + ", ".join(f".{a}" for a in sorted(allowed)) + ".")
    chunks, size = [], 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > max_bytes:
            raise HTTPException(413, f"File is larger than {max_bytes // (1024 * 1024)} MB. Split it or export just the rows you need.")
        chunks.append(chunk)
    content = b"".join(chunks)
    if not content:
        raise HTTPException(422, "The file is empty.")
    if not check_signature(content, ext):
        raise HTTPException(422, f"This doesn't look like a real .{ext} file.")
    if ext in {"xlsx"} or (ext == "xls" and content.startswith(b"PK")):
        check_zip_safe(content)
    return content, ext


async def read_json_limited(request: Request, max_bytes: int = MAX_JSON_BYTES):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(413, "Request is too large.")
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise HTTPException(413, "Request is too large.")
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks) or b"null")
    except ValueError as e:
        raise HTTPException(400, "Body must be JSON.") from e


def _guarded(fn, args, wait: float):
    if not HEAVY_SLOTS.acquire(timeout=wait):
        raise HTTPException(503, "The server is busy processing other files. Try again in a minute.")
    try:
        return fn(*args)
    finally:
        HEAVY_SLOTS.release()


async def run_heavy(fn, *args, timeout: float = HEAVY_TIMEOUT_SECONDS):
    """Runs CPU-heavy work (PDF/Excel/OCR/report building) off the event loop, at most
    HEAVY_CONCURRENCY at a time, answering 504 instead of hanging if it runs long."""
    try:
        return await asyncio.wait_for(run_in_threadpool(_guarded, fn, args, timeout), timeout)
    except asyncio.TimeoutError as e:
        log.warning("heavy operation %s timed out after %ss", getattr(fn, "__name__", "?"), timeout)
        raise HTTPException(504, "That took too long to process. Try a smaller file.") from e


def neutralize_formulas(workbook) -> int:
    """Turns every formula cell in a workbook we generated into plain text. Reports
    only ever contain values, so anything openpyxl read as a formula came from an
    imported file (a product named '=HYPERLINK(...)'); it must not run in Excel."""
    fixed = 0
    for ws in workbook.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    cell.data_type = "s"
                    fixed += 1
    return fixed


def security_headers(is_https: bool) -> Dict[str, str]:
    headers = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Security-Policy": os.environ.get("CONTENT_SECURITY_POLICY", DEFAULT_CSP),
    }
    if is_https:
        headers["Strict-Transport-Security"] = "max-age=31536000"
    return headers


# The app is same-origin scripts only; Google Maps (optional) needs its own hosts.
DEFAULT_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://maps.googleapis.com https://maps.gstatic.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.ggpht.com https://*.google.com",
    "font-src 'self' data:",
    "connect-src 'self' https://*.onrender.com https://*.googleapis.com https://*.gstatic.com",
    "worker-src blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])
