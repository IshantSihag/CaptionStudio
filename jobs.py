"""
jobs.py -- background job manager. Long steps (transcription, export) run in
worker threads and expose status / progress / log lines for the GUI to poll.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from typing import Callable, Dict, List, Optional

MAX_LOG_LINES = 400


class BusyError(Exception):
    pass


class Job:
    def __init__(self, job_id: str, kind: str, stages: List[Dict]):
        self.id = job_id
        self.kind = kind
        self.stages = stages  # [{"key": ..., "label": ...}]
        self.stage_key = stages[0]["key"] if stages else None
        self.stage_index = 0
        self.progress: Optional[float] = None  # 0..1 or None = indeterminate
        self.message = ""
        self.status = "running"  # running | done | error | cancelled
        self.error: Optional[str] = None
        self.result: Optional[Dict] = None
        self.log: List[str] = []
        self.log_count = 0  # total lines ever logged (monotonic)
        self.started = time.time()
        self.finished: Optional[float] = None
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()

    # -- mutations (thread safe) ------------------------------------------
    def set_stage(self, key: str, message: str = "", progress: Optional[float] = None) -> None:
        with self._lock:
            for i, s in enumerate(self.stages):
                if s["key"] == key:
                    self.stage_index = i
                    break
            self.stage_key = key
            self.message = message
            self.progress = progress

    def set_progress(self, progress: Optional[float], message: Optional[str] = None) -> None:
        with self._lock:
            if progress is not None:
                self.progress = max(0.0, min(1.0, float(progress)))
            if message is not None:
                self.message = message

    def log_line(self, line: str) -> None:
        line = str(line).replace("\t", " ")[:500]
        with self._lock:
            self.log.append(line)
            self.log_count += 1
            if len(self.log) > MAX_LOG_LINES:
                del self.log[: len(self.log) - MAX_LOG_LINES]

    def finish(self, result: Optional[Dict] = None) -> None:
        with self._lock:
            self.status = "done"
            self.result = result
            self.progress = 1.0
            self.finished = time.time()

    def fail(self, message: str) -> None:
        with self._lock:
            self.status = "error"
            self.error = str(message)
            self.finished = time.time()

    def mark_cancelled(self) -> None:
        with self._lock:
            self.status = "cancelled"
            self.error = "Cancelled."
            self.finished = time.time()

    @property
    def active(self) -> bool:
        return self.status == "running"

    def to_dict(self, log_from: int = 0) -> Dict:
        with self._lock:
            dropped = self.log_count - len(self.log)
            return {
                "id": self.id,
                "kind": self.kind,
                "status": self.status,
                "stages": list(self.stages),
                "stage_key": self.stage_key,
                "stage_index": self.stage_index,
                "progress": self.progress,
                "message": self.message,
                "error": self.error,
                "result": self.result,
                "started": self.started,
                "finished": self.finished,
                "log": self.log[max(0, log_from - dropped):],
                "log_total": self.log_count,
            }


class JobManager:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._current: Optional[Job] = None
        self._lock = threading.Lock()

    def start(self, kind: str, stages: List[Dict], fn: Callable[[Job], Dict]) -> Job:
        with self._lock:
            if self._current is not None and self._current.active:
                raise BusyError("Another task is already running.")
            job = Job(uuid.uuid4().hex[:12], kind, stages)
            self._jobs[job.id] = job
            self._current = job

        def _run() -> None:
            try:
                result = fn(job) or {}
                if job.cancel_event.is_set() and job.status == "running":
                    job.mark_cancelled()
                else:
                    job.finish(result)
            except Exception as exc:  # noqa: BLE001 - surfaced in the GUI
                from media import Cancelled  # local import to avoid cycle

                if isinstance(exc, Cancelled) or job.cancel_event.is_set():
                    job.mark_cancelled()
                else:
                    job.log_line("ERROR: %s" % exc)
                    job.log_line(traceback.format_exc().strip().splitlines()[-1])
                    job.fail(str(exc))

        threading.Thread(target=_run, daemon=True, name="job-%s" % job.id).start()
        return job

    @property
    def current(self) -> Optional[Job]:
        with self._lock:
            return self._current

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel_current(self) -> bool:
        job = self.current
        if job is None or not job.active:
            return False
        job.cancel_event.set()
        job.message = "Cancelling…"
        return True
