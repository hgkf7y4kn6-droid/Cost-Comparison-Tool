"""Business card scanning (see cards.py)."""
from fastapi import APIRouter, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

import cards

router = APIRouter()


@router.post("/cards/scan")
async def scan_business_card(file: UploadFile = File(...)):
    """Reads a business card photo into suggested contact/company fields. Nothing is stored."""
    content = await file.read(cards.MAX_IMAGE_BYTES + 1)
    try:
        return await run_in_threadpool(cards.scan_card, content)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e


@router.get("/cards/status")
async def scan_status():
    return {"ai": cards.ai_available()}
