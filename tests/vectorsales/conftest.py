import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from vectorsales.ledger import Ledger  # noqa: E402
from vectorsales.store import Store  # noqa: E402


@pytest.fixture()
def store():
    return Store()


@pytest.fixture()
def ledger():
    return Ledger()


def make_fake_llm(replies):
    """A CrewAI-compatible LLM that returns scripted replies (no network, no cost)."""
    from crewai import BaseLLM

    class FakeLLM(BaseLLM):
        def __init__(self):
            super().__init__(model="fake-model")
            self.calls = 0
            self.prompts = []

        def call(self, messages, tools=None, callbacks=None, available_functions=None, from_task=None, from_agent=None, **kw):
            self.prompts.append(json.dumps(messages))
            r = replies(self.prompts[-1]) if callable(replies) else replies[min(self.calls, len(replies) - 1)]
            self.calls += 1
            if isinstance(r, Exception):
                raise r
            return r if isinstance(r, str) else json.dumps(r)

        def supports_function_calling(self):
            return False

    return FakeLLM()
