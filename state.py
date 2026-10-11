"""
state.py -- shared, thread-safe application state (the current project).
"""

from __future__ import annotations

import threading
from typing import Any, Dict, Optional


class AppState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.tools: Dict[str, Any] = {}
        self.project: Optional[Dict[str, Any]] = None

    # -- project -----------------------------------------------------------
    def set_project(self, project: Dict[str, Any]) -> None:
        with self._lock:
            self.project = project

    def update_project(self, **values: Any) -> None:
        with self._lock:
            if self.project is None:
                self.project = {}
            self.project.update(values)

    def get_project(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self.project is None:
                return None
            return dict(self.project)

    def clear_project(self) -> None:
        with self._lock:
            self.project = None

    # -- tools -------------------------------------------------------------
    def set_tools(self, tools: Dict[str, Any]) -> None:
        with self._lock:
            self.tools = tools

    def get_tools(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self.tools)

    # -- combined ----------------------------------------------------------
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "tools": dict(self.tools),
                "project": dict(self.project) if self.project else None,
            }
