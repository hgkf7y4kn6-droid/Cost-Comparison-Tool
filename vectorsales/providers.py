"""Data-provider access as a managed, budgeted resource.

Business code asks for a *capability* ("company_enrichment", "email_verification"…);
the registry picks providers by priority and tier, enforces rate/concurrency limits,
timeouts and bounded retries with exponential backoff and jitter, opens a circuit
after repeated failures, books the cost in the ledger *before* calling (so budgets
hold under concurrency) and records what was actually charged.

No real vendor is bundled: a provider is a small class with `call(payload) -> dict`.
Wire a real one only with credentials you are licensed to use, inside the vendor's terms.
"""
import concurrent.futures
import random
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from .ledger import Ledger


class ProviderError(Exception):
    """A failed call that may be retried."""


class AllProvidersFailed(Exception):
    pass


class NoProvider(Exception):
    pass


class Provider:
    name = "provider"
    capability = ""
    tier = 1                     # 1 = inexpensive first pass, 2 = premium escalation
    cost_per_call_micro = 0      # what one successful call is expected to cost

    def call(self, payload: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover - interface
        raise NotImplementedError

    def actual_cost_micro(self, result: Dict[str, Any]) -> Optional[int]:
        """Override when the provider reports what it charged; None = use the estimate."""
        return None


class _State:
    def __init__(self, provider: Provider, priority: int, timeout: float, retries: int, fail_threshold: int,
                 cooldown: float, max_concurrent: int, min_interval: float):
        self.p, self.priority, self.timeout, self.retries = provider, priority, timeout, retries
        self.fail_threshold, self.cooldown, self.min_interval = fail_threshold, cooldown, min_interval
        self.sem = threading.BoundedSemaphore(max_concurrent)
        self.failures = 0
        self.opened_at: Optional[float] = None
        self.calls = self.errors = self.rate_limited = 0
        self.latency_total = 0.0
        self.last_call = 0.0
        self.lock = threading.Lock()


class Registry:
    def __init__(self, ledger: Ledger, *, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic, rng: Callable[[], float] = random.random):
        self.ledger, self.sleep, self.clock, self.rng = ledger, sleep, clock, rng
        self.states: List[_State] = []
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="vs-provider")

    def register(self, provider: Provider, *, priority: int = 100, timeout: float = 10.0, retries: int = 2,
                 fail_threshold: int = 3, cooldown: float = 60.0, max_concurrent: int = 2, max_per_second: float = 0) -> None:
        self.states.append(_State(provider, priority, timeout, retries, fail_threshold, cooldown, max_concurrent,
                                  1.0 / max_per_second if max_per_second else 0.0))
        self.states.sort(key=lambda s: s.priority)

    def _open(self, st: _State) -> bool:
        if st.opened_at is None:
            return False
        if self.clock() - st.opened_at >= st.cooldown:
            st.opened_at = None  # half-open: let one attempt through
            st.failures = st.fail_threshold - 1
            return False
        return True

    def _attempt(self, st: _State, payload: Dict[str, Any]) -> Dict[str, Any]:
        with st.sem:
            with st.lock:
                wait = st.min_interval - (self.clock() - st.last_call)
                st.last_call = self.clock() + max(wait, 0)
            if wait > 0:
                self.sleep(wait)
            fut = self.pool.submit(st.p.call, payload)
            try:
                return fut.result(timeout=st.timeout)
            except concurrent.futures.TimeoutError as e:
                fut.cancel()
                raise ProviderError(f"{st.p.name} timed out after {st.timeout:g}s") from e

    def call(self, capability: str, payload: Dict[str, Any], *, tenant: str, workflow: str = "", campaign: str = "",
             operation: str = "", tier: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        candidates = [s for s in self.states if s.p.capability == capability and (tier is None or s.p.tier == tier)]
        if not candidates:
            raise NoProvider(f"No provider is configured for '{capability}'" + (f" at tier {tier}." if tier else "."))
        last: Optional[Exception] = None
        for st in candidates:
            if self._open(st):
                last = ProviderError(f"{st.p.name} is temporarily disabled after repeated failures")
                continue
            # BudgetExceeded is deliberately not caught: a hard limit stops the work instead of trying the next provider.
            rid = self.ledger.reserve(tenant, st.p.cost_per_call_micro, kind="provider", provider=st.p.name,
                                      workflow=workflow, campaign=campaign, operation=operation or capability)
            for attempt in range(1, st.retries + 2):
                t0 = self.clock()
                try:
                    result = self._attempt(st, payload)
                except ProviderError as e:
                    last = e
                    st.errors += 1
                    if "429" in str(e) or "rate" in str(e).lower():
                        st.rate_limited += 1
                    st.failures += 1
                    if st.failures >= st.fail_threshold:
                        st.opened_at = self.clock()
                    if attempt <= st.retries and st.opened_at is None:
                        self.sleep(min(30.0, 0.5 * 2 ** (attempt - 1)) * (0.5 + self.rng()))  # backoff with jitter
                        continue
                    self.ledger.settle(rid, cost_micro=0, estimated=False, ok=False, attempt=attempt)
                    break
                st.calls += 1
                st.failures = 0
                st.latency_total += self.clock() - t0
                actual = st.p.actual_cost_micro(result)
                self.ledger.settle(rid, cost_micro=actual, estimated=actual is None, ok=True, attempt=attempt)
                return st.p.name, result
        raise AllProvidersFailed(f"Every provider for '{capability}' failed: {last}")

    def health(self) -> List[Dict[str, Any]]:
        return [{"provider": s.p.name, "capability": s.p.capability, "tier": s.p.tier, "calls": s.calls, "errors": s.errors,
                 "rate_limited": s.rate_limited, "avg_latency_s": round(s.latency_total / s.calls, 3) if s.calls else None,
                 "circuit": "open" if s.opened_at is not None else "closed"} for s in self.states]
