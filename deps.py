"""Process-wide services shared by the route modules: sign-in and the shared-records store."""
import os
import tempfile

import auth
from accounts_store import RecordStore

authenticator = auth.from_environment()


# DATABASE_URL (a Postgres connection string for the vectorsales_app role) switches
# the shared records to Postgres with per-org isolation; otherwise they stay in SQLite.
if os.environ.get("DATABASE_URL"):
    from records_pg import PostgresRecordStore

    record_store = PostgresRecordStore(os.environ["DATABASE_URL"])
else:
    record_store = RecordStore(os.path.join(os.environ.get("DATA_DIR", tempfile.gettempdir()), "sales_hub.db"))


def ai_allowed(request) -> bool:
    """True only when the signed-in user has agreed, in the app, to send their text and photos to the AI
    provider. The app sends this header after the user says yes (Apple and Google require that consent);
    without it every AI feature falls back to its non-AI behavior."""
    return request.headers.get("x-ai-consent", "").strip().lower() == "granted"
