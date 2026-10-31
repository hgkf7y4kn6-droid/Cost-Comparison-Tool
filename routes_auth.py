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
