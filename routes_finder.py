"""Customer finder (Prospecting tab): Google Maps + Apollo, keys kept on the server."""
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import prospect_finder as pf

router = APIRouter()
budget = pf.Budget()


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be a JSON object.")
    return body


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _run(fn, *args):
    try:
        return fn(*args)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except pf.BudgetExceeded as e:
        raise HTTPException(429, str(e)) from e
    except pf.ProviderError as e:
        raise HTTPException(502, str(e)) from e
    except pf.SearchFailed as e:
        raise HTTPException(502, str(e)) from e


@router.get("/finder/status")
async def finder_status(request: Request):
    return {**pf.status(), "remaining": budget.remaining(request.state.user)}


@router.post("/finder/search")
async def finder_search(request: Request):
    body = await _json(request)
    return await run_in_threadpool(
        _run, pf.search, budget, request.state.user, str(body.get("segment", "")), str(body.get("area", "")),
        _int(body.get("min_employees"), pf.DEFAULT_MIN_EMPLOYEES), _int(body.get("max_employees"), pf.DEFAULT_MAX_EMPLOYEES),
        _int(body.get("limit"), 40))


@router.post("/finder/enrich")
async def finder_enrich(request: Request):
    body = await _json(request)
    return await run_in_threadpool(_run, pf.enrich, budget, request.state.user, body)
