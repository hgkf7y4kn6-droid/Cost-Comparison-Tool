import os
import sys

# Make the repo root importable (auth.py, accounts_store.py live there).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
