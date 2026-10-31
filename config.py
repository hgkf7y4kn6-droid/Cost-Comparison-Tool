"""Shared settings and paths."""
import os
import tempfile

VALID_TIERS = {"good", "better", "best"}
OFFICEBASICS_PORTAL_URL = "https://supplies.officebasics.com/"
# DATA_DIR lets a host (e.g. a Render persistent disk) keep reports and learned
# feedback across restarts; defaults to the system temp dir for local runs.
REPORTS_DIR = os.path.join(os.environ.get("DATA_DIR", tempfile.gettempdir()), "ob_reports")
os.makedirs(REPORTS_DIR, exist_ok=True)
FEEDBACK_PATH = os.path.join(REPORTS_DIR, "feedback_store.json")
FEEDBACK_SIMILARITY_THRESHOLD = 0.88  # cosine sim (CLIP embeddings are L2-normalized)
