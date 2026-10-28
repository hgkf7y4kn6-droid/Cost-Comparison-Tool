"""Starts the real backend with the model libraries stubbed (see tests/conftest.py)
so browser tests can run without PyTorch. Usage: python tests/e2e/serve.py PORT"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path[:0] = [ROOT, os.path.join(ROOT, "tests")]

import conftest  # noqa: E402,F401  installs the fakes and test environment variables

import uvicorn  # noqa: E402

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print("DATA_DIR", os.environ["DATA_DIR"], flush=True)
    uvicorn.run("backend:app", host="127.0.0.1", port=port, log_level="warning")
