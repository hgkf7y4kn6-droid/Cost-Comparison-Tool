"""Shared accounts and leads (see accounts_store.py / records_pg.py for who sees what)."""
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from deps import authenticator, record_store

router = APIRouter()


def _record_call(fn, *args):
    try:
        return fn(*args)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/records/{kind}/")
async def list_records(kind: str, request: Request):
    email = request.state.user
    role = authenticator.role(email)
    full, limited = await run_in_threadpool(_record_call, record_store.list_visible, kind, email, role == "manager")
    return {"records": full, "others": limited, "role": role}


@router.post("/records/{kind}/bulk")
async def save_records(kind: str, request: Request):
    email = request.state.user
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON.")
    records = body.get("records") if isinstance(body, dict) else None
    return await run_in_threadpool(_record_call, record_store.save_many, kind, records, email, authenticator.role(email) == "manager")


@router.put("/records/{kind}/{record_id}")
async def save_record(kind: str, record_id: str, request: Request):
    email = request.state.user
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON.")
    return await run_in_threadpool(_record_call, record_store.save, kind, record_id, data, email, authenticator.role(email) == "manager")


@router.delete("/records/{kind}/{record_id}")
async def delete_record(kind: str, record_id: str, request: Request):
    email = request.state.user
    found = await run_in_threadpool(_record_call, record_store.delete, kind, record_id, email, authenticator.role(email) == "manager")
    if not found:
        raise HTTPException(404, "No such record.")
    return {"deleted": record_id}
