"""Sign-in routes."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from deps import authenticator

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


def _client_ip(request: Request) -> str:
    # Render's proxy appends the real client address as the last X-Forwarded-For entry.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


@router.post("/auth/login")
async def login(payload: LoginRequest, request: Request):
    if not authenticator.configured:
        raise HTTPException(503, "Sign-in isn't set up on the server yet (AUTH_USERS is empty).")
    ip = _client_ip(request)
    email = payload.email.strip().lower()
    if authenticator.locked_out(email, ip):
        raise HTTPException(429, "Too many failed sign-in attempts. Try again in 15 minutes.")
    # PBKDF2 is deliberately slow; keep it off the event loop.
    user = await run_in_threadpool(authenticator.login, email, payload.password, ip)
    if not user:
        raise HTTPException(401, "Email or password is incorrect.")
    token, expires_at = authenticator.issue_token(user)
    return {"token": token, "email": user, "expires_at": expires_at, "role": authenticator.role(user)}


@router.get("/auth/me")
async def who_am_i(request: Request):
    email = request.state.user
    return {"email": email, "role": authenticator.role(email)}


class DeleteAccountRequest(BaseModel):
    password: str
    confirm: str = ""


@router.post("/auth/delete-account")
async def delete_account(payload: DeleteAccountRequest, request: Request):
    """Erases the signed-in user's data and blocks their login (App Store / Google Play account deletion).

    Removes the accounts and leads they own, their note inbox and their saved coach knowledge, and
    deactivates the sign-in. Quotes, catalog and settings live in their own browser, which the app clears.
    Requires the password and the word DELETE, so a stolen session can't wipe an account.
    """
    import routes_coach
    import routes_notes
    from deps import record_store

    email = request.state.user
    if payload.confirm.strip().upper() != "DELETE":
        raise HTTPException(422, "Type DELETE to confirm.")
    ip = _client_ip(request)
    if authenticator.locked_out(email, ip):
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")
    if not await run_in_threadpool(authenticator.login, email, payload.password, ip):
        # 403, not 401: the browser treats any 401 as an expired session and signs the user out.
        raise HTTPException(403, "That password is incorrect.")
    is_manager = authenticator.role(email) == "manager"

    def erase() -> dict:
        removed = {"accounts": 0, "leads": 0}
        for kind in removed:
            full, _ = record_store.list_visible(kind, email, is_manager)
            for rec in full:
                if rec.get("ownerEmail") == email and record_store.delete(kind, rec["id"], email, is_manager):
                    removed[kind] += 1
        removed["notes"] = routes_notes.inbox.erase_user(email)
        removed["knowledge"] = routes_coach.store.erase_user(email)
        authenticator.deactivate(email)
        return removed

    return {"deleted": True, "removed": await run_in_threadpool(erase)}
