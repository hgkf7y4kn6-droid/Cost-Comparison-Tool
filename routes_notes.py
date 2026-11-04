"""Quick note capture: AI/rule-based tidy-up of a dictated note, and an inbox
for notes posted by outside tools (CRM automations, AI meeting recorders)."""
import os
import tempfile

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import notes
from deps import authenticator

router = APIRouter()
inbox = notes.NoteInbox(os.path.join(os.environ.get("DATA_DIR", tempfile.gettempdir()), "note_inbox.db"))


async def _json(request: Request):
    try:
        return await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON.")


@router.post("/notes/structure")
async def structure(request: Request):
    body = await _json(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be a JSON object.")
    try:
        return await run_in_threadpool(notes.structure_note, body.get("text", ""), str(body.get("context", "")))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/notes/integration")
async def integration_info(request: Request):
    """What a rep needs to connect an outside tool: their key and whether AI tidy-up is on."""
    return {"key": authenticator.integration_key(request.state.user), "ai": notes.ai_available()}


@router.post("/notes/inbound")
async def inbound(request: Request):
    """Called by outside tools with `Authorization: Bearer <integration key>`; queues the note for review."""
    try:
        item = notes.clean_inbound(await _json(request))
        item_id = await run_in_threadpool(inbox.add, request.state.user, item)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return {"id": item_id, "queued": True}


@router.get("/notes/inbox")
async def list_inbox(request: Request):
    return {"notes": await run_in_threadpool(inbox.pending, request.state.user)}


@router.delete("/notes/inbox/{item_id}")
async def remove_from_inbox(item_id: str, request: Request):
    if not await run_in_threadpool(inbox.remove, request.state.user, item_id):
        raise HTTPException(404, "No such note.")
    return {"deleted": item_id}
