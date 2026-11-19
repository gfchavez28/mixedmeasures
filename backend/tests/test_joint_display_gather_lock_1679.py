"""#1679 D368 — one heavy joint display gather at a time per process.

Four displays computed at once on D12 took ~720 s each against ~18 s alone (the 2026-11-17c
review: a cliff inside one interpreter between three and four at once). `compute` and `cases`
share a process-wide lock of ONE; `passages` stays outside it (the pin picker asks one at a
time, and an open dialog must not wait behind a canvas's computes).

The services are replaced by stand-ins that record how many run at once, so the test measures
the LOCK and nothing else (the gather's own cost is the review's measurement).
"""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from app.routers import joint_display as jd


class _Probe:
    def __init__(self):
        self.lock = threading.Lock()
        self.inside = 0
        self.most = 0

    def run(self, *a, **k):
        with self.lock:
            self.inside += 1
            self.most = max(self.most, self.inside)
        time.sleep(0.05)
        with self.lock:
            self.inside -= 1
        return {}


@pytest.fixture
def probe(monkeypatch):
    p = _Probe()
    monkeypatch.setattr(jd, "_get_project_or_404", lambda *a, **k: None)
    monkeypatch.setattr(jd, "compute_joint_display", p.run)
    monkeypatch.setattr(jd, "read_cases", p.run)
    return p


def _compute_body():
    return SimpleNamespace(group_by_column_id=1, rows=[], strands=None, conversation_ids=None,
                           document_ids=None, coder_ids=None, layer_scope="human", newcombe=False)


def _cases_body():
    return SimpleNamespace(strands=None, conversation_ids=None, document_ids=None,
                           group_by_column_id=1, bindings={}, coder_ids=None, layer_scope="human",
                           rule=None, only="all", added_participant_ids=[],
                           removed_participant_ids=[], offset=0, limit=0)


def _all_at_once(calls):
    threads = [threading.Thread(target=c) for c in calls]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)


def test_four_computes_and_two_case_reads_run_one_after_another(probe):
    _all_at_once(
        [lambda: jd.compute(1, _compute_body(), user=SimpleNamespace(id=1), db=None)] * 4
        + [lambda: jd.case_rows(1, _cases_body(), user=SimpleNamespace(id=1), db=None)] * 2)
    assert probe.most == 1, f"{probe.most} heavy gathers ran at once"


def test_CONTROL_without_the_lock_they_overlap(probe, monkeypatch):
    """The probe can see overlap — so the assertion above could fail."""
    class _NoLock:
        def __enter__(self): return self
        def __exit__(self, *exc): return False
    monkeypatch.setattr(jd, "_HEAVY_GATHER", _NoLock())
    _all_at_once([lambda: jd.compute(1, _compute_body(), user=SimpleNamespace(id=1), db=None)] * 4)
    assert probe.most > 1


def test_passages_is_not_held_behind_a_compute(monkeypatch):
    monkeypatch.setattr(jd, "_get_project_or_404", lambda *a, **k: None)
    monkeypatch.setattr(jd, "group_passages", lambda *a, **k: {"passages": []})
    assert jd._HEAVY_GATHER.acquire(timeout=1)   # a compute holds the lock
    try:
        done = []
        t = threading.Thread(target=lambda: done.append(jd.passages(
            1, SimpleNamespace(group_by_column_id=1, group="High", code_id=1, conversation_ids=None,
                               document_ids=None, coder_ids=None, layer_scope="human",
                               chips_follow_coder_ids=False, limit=50, offset=0, text_column_ids=[]),
            user=SimpleNamespace(id=1), db=None)))
        t.start()
        t.join(timeout=2)
        assert done, "the pin picker's read waited behind a compute"
    finally:
        jd._HEAVY_GATHER.release()


def test_the_lock_is_one_and_bounded():
    assert isinstance(jd._HEAVY_GATHER, type(threading.BoundedSemaphore(1)))
    assert jd._HEAVY_GATHER._initial_value == 1
