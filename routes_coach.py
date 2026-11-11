"""AI personas (coaches) and their knowledge base."""
import os
import tempfile

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import personas
from deps import ai_allowed, authenticator

router = APIRouter()
store = personas.KnowledgeStore(os.path.join(os.environ.get("DATA_DIR", tempfile.gettempdir()), "coach.db"))


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be a JSON object.")
    return body


def _manager(request: Request) -> bool:
    return authenticator.role(request.state.user) == "manager"


@router.get("/coach/personas")
async def list_personas():
    return {"personas": [personas.public_persona(p) for p in personas.PERSONAS], "ai": personas.ai_available()}


@router.post("/coach/ask")
async def ask(request: Request):
    body = await _json(request)
    try:
        return await run_in_threadpool(personas.ask, store, request.state.user, str(body.get("persona", "")),
                                       body.get("question", ""), body.get("history"), body.get("deal"), ai_allowed(request))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/coach/knowledge")
async def list_knowledge(request: Request):
    entries = await run_in_threadpool(personas.all_knowledge, store, request.state.user)
    return {"entries": [{k: e[k] for k in ("id", "title", "body", "personas", "builtin", "shared", "mine")} for e in entries]}


@router.post("/coach/knowledge")
async def add_knowledge(request: Request):
    body = await _json(request)
    plist = body.get("personas")
    try:
        entry = await run_in_threadpool(
            store.add, request.state.user, _manager(request), body.get("title", ""), body.get("body", ""),
            plist if isinstance(plist, list) else [], bool(body.get("shared")))
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return {k: entry[k] for k in ("id", "title", "body", "personas", "builtin", "shared", "mine")}


@router.delete("/coach/knowledge/{entry_id}")
async def delete_knowledge(entry_id: str, request: Request):
    try:
        found = await run_in_threadpool(store.remove, request.state.user, _manager(request), entry_id)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    if not found:
        raise HTTPException(404, "No such entry.")
    return {"deleted": entry_id}
