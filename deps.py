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
