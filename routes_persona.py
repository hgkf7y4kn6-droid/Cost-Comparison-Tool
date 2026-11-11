"""Buyer persona inference and style-matched outreach drafts. Stateless: the app sends the signals it already holds."""
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import buyer_persona

router = APIRouter()


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be a JSON object.")
    return body


@router.post("/persona/infer")
async def infer(request: Request):
    body = await _json(request)
    return await run_in_threadpool(buyer_persona.infer, body.get("signals"))


@router.post("/persona/draft")
async def draft(request: Request):
    body = await _json(request)
    base = body.get("base")
    if not isinstance(base, dict):
        raise HTTPException(422, "Send the lead's draft fields as `base`.")
    return await run_in_threadpool(buyer_persona.draft, base, body.get("signals"), str(body.get("signature", "")))
