"""
server.py -- the local web server behind the Caption Studio GUI.
Serves the frontend, exposes the JSON API and streams video with range
support (so the editor can seek). Binds to 127.0.0.1 only.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

import asslib
import media
import tasks
from jobs import BusyError, Job, JobManager
from state import AppState

MAX_BODY = 3 * 1024 * 1024
FRAME_CACHE_MAX = 60


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """Hide the scary-but-harmless tracebacks when a browser tab closes.

        The browser's frame previews abort the previous in-flight fetch each
        time a new one starts, so connection teardown is routine: on Windows
        that surfaces as ConnectionAbortedError (WinError 10053), and on other
        platforms as ConnectionResetError / BrokenPipeError / TimeoutError.
        All of those are normal here and should not dump a traceback.
        """
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)

    def __init__(self, address, state: AppState, jobs: JobManager, static_dir: Path):
        self.state = state
        self.jobs = jobs
        self.static_dir = Path(static_dir).resolve()
        self._frame_cache: Dict[Any, bytes] = {}
        self._frame_lock = threading.Lock()
        super().__init__(address, StudioHandler)


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "CaptionStudio"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------
    @property
    def app(self) -> StudioServer:  # type: ignore[override]
        return self.server  # type: ignore[return-value]

    def log_message(self, fmt: str, *args) -> None:
        try:
            print("[web] %s - %s" % (self.address_string(), fmt % args))
        except Exception:
            pass

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8",
              extra: Optional[Dict[str, str]] = None) -> None:
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if body:
                self.wfile.write(body)
        except ConnectionError:
            pass

    def _json(self, obj: Any, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"))

    def _error(self, message: str, code: int = 400) -> None:
        self._json({"error": message}, code)

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("That is too much data to save.")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8", "replace"))
        if not isinstance(data, dict):
            raise ValueError("Invalid request body.")
        return data

    # -- routing -----------------------------------------------------------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if path in ("/", "/index.html"):
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            if path == "/api/state":
                return self._get_state(query)
            if path == "/api/ass":
                return self._get_ass()
            if path == "/api/frame":
                return self._get_frame(query)
            if path in ("/api/video", "/api/result"):
                return self._stream_video(path)
            return self._error("Not found.", 404)
        except ConnectionError:
            pass
        except Exception as exc:  # noqa: BLE001
            self._safe_error(exc)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self._read_json()
            if path == "/api/pick_video":
                return self._pick_video()
            if path == "/api/start":
                return self._start(body)
            if path == "/api/regenerate":
                return self._regenerate()
            if path == "/api/ass":
                return self._save_ass(body)
            if path == "/api/export":
                return self._export()
            if path == "/api/cancel":
                return self._cancel()
            if path == "/api/action":
                return self._action(body)
            if path == "/api/reset":
                return self._reset()
            if path == "/api/recheck_tools":
                return self._recheck()
            return self._error("Not found.", 404)
        except ConnectionError:
            pass
        except BusyError as exc:
            self._safe_error(exc, 409)
        except ValueError as exc:
            self._safe_error(exc, 400)
        except Exception as exc:  # noqa: BLE001
            self._safe_error(exc)

    def _safe_error(self, exc: Exception, code: int = 500) -> None:
        try:
            self._error(str(exc) or exc.__class__.__name__, code)
        except Exception:
            pass

    # -- static files ------------------------------------------------------
    def _static(self, rel: str) -> None:
        base = self.app.static_dir
        target = (base / rel).resolve()
        try:
            inside = os.path.commonpath([str(base), str(target)]) == str(base)
        except ValueError:
            inside = False
        if not inside or not target.is_file():
            return self._error("Not found.", 404)
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        self._send(200, data, ctype)

    # -- API: state --------------------------------------------------------
    def _get_state(self, query: Dict[str, str]) -> None:
        snap = self.app.state.snapshot()
        job = self.app.jobs.current
        log_from = 0
        try:
            log_from = int(query.get("log_from", "0"))
        except ValueError:
            log_from = 0
        self._json({
            "platform": "darwin" if media.IS_MAC else ("win32" if media.IS_WIN else "linux"),
            "tools": snap["tools"],
            "project": snap["project"],
            "job": job.to_dict(log_from) if job else None,
        })

    def _recheck(self) -> None:
        tools = media.tool_report()
        self.app.state.set_tools(tools)
        self._json(tools)

    # -- API: file picking -------------------------------------------------
    def _pick_video(self) -> None:
        status, path = media.pick_video()
        if status == "ok":
            self._json({"status": "ok", "path": path})
        elif status == media.DIALOG_CANCELLED:
            self._json({"status": "cancelled"})
        else:
            self._json({"status": "unavailable",
                        "error": "The file dialog could not be opened."})

    # -- API: starting a project ------------------------------------------
    def _start(self, body: Dict[str, Any]) -> None:
        if self.app.jobs.current and self.app.jobs.current.active:
            raise BusyError("Another task is still running — cancel it first.")

        raw_path = str(body.get("path") or "").strip().strip('"').strip("'")
        if not raw_path:
            return self._error("Choose a video file first.")
        path = Path(raw_path).expanduser()
        if not path.exists() or not path.is_file():
            return self._error("No file was found at that path:\n%s" % raw_path)
        if path.suffix.lower() not in media.VIDEO_EXTENSIONS:
            return self._error(
                "“%s” is not a supported video type. Use MP4, MOV, MKV, WEBM, AVI…"
                % (path.suffix or "that file")
            )
        try:
            info = media.probe_video(str(path))
        except media.ToolError as exc:
            return self._error(str(exc), 500)
        except (ValueError, RuntimeError) as exc:
            return self._error(str(exc), 400)

        work = path.parent / (path.stem + "_captions")
        try:
            work.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return self._error("Could not create the work folder: %s" % exc, 500)

        ass_path = work / tasks.AUDIO_ASS
        captions_ready = False
        if ass_path.exists():
            try:
                doc = asslib.AssDoc(ass_path.read_text(encoding="utf-8", errors="replace"))
                captions_ready = doc.cue_count() > 0
            except Exception:
                captions_ready = False

        needs_proxy = not info["web_safe"]
        proxy_path = work / tasks.PROXY_MP4
        proxy_ready = (not needs_proxy) or (
            proxy_path.exists()
            and proxy_path.stat().st_mtime >= path.stat().st_mtime - 1
        )

        export_path = tasks.default_export_path(str(path))
        project = {
            "video_path": str(path),
            "video_name": path.name,
            "duration": info["duration"],
            "width": info["width"],
            "height": info["height"],
            "vcodec": info.get("vcodec"),
            "acodec": info.get("acodec"),
            "has_audio": info.get("acodec") is not None,
            "work_dir": str(work),
            "needs_proxy": needs_proxy,
            "proxy_ready": proxy_ready,
            "captions_ready": captions_ready,
            "ass_rev": 1 if captions_ready else 0,
            "srt_exists": (work / tasks.AUDIO_SRT).exists(),
            "export_path": export_path if Path(export_path).exists() else None,
            "export_done": Path(export_path).exists(),
        }
        self.app.state.set_project(project)

        if captions_ready:
            return self._json({"status": "ready", "project": project})

        job = self._begin_process()
        return self._json({"status": "processing", "project": project, "job": job.to_dict()})

    def _begin_process(self) -> Job:
        stages = tasks.process_stages(self.app.state.get_project() or {})
        return self.app.jobs.start(
            "process", stages,
            lambda job: tasks.process_task(job, self.app.state),
        )

    def _regenerate(self) -> None:
        project = self.app.state.get_project()
        if not project:
            return self._error("Open a video first.")
        if self.app.jobs.current and self.app.jobs.current.active:
            raise BusyError("Another task is still running — cancel it first.")
        self.app.state.update_project(captions_ready=False, export_done=False)
        job = self._begin_process()
        self._json({"status": "processing", "job": job.to_dict()})

    # -- API: captions file ------------------------------------------------
    def _ass_path(self) -> Optional[Path]:
        project = self.app.state.get_project()
        if not project:
            return None
        return Path(project["work_dir"]) / tasks.AUDIO_ASS

    def _get_ass(self) -> None:
        path = self._ass_path()
        if path is None or not path.exists():
            return self._error("There is no caption file yet.", 404)
        text = path.read_text(encoding="utf-8", errors="replace")
        project = self.app.state.get_project() or {}
        self._json({"text": text, "rev": int(project.get("ass_rev") or 0)})

    def _save_ass(self, body: Dict[str, Any]) -> None:
        path = self._ass_path()
        if path is None:
            return self._error("Open a video first.")
        text = body.get("text")
        if not isinstance(text, str):
            return self._error("No caption data received.")
        if not text.strip():
            return self._error("The caption file cannot be empty.")
        if len(text) > 2 * 1024 * 1024:
            return self._error("The caption file is too large.")
        tasks.atomic_write(path, text)
        rev = int((self.app.state.get_project() or {}).get("ass_rev") or 0) + 1
        self.app.state.update_project(ass_rev=rev, captions_ready=True)
        self._json({"rev": rev})

    # -- API: preview frame ------------------------------------------------
    def _get_frame(self, query: Dict[str, str]) -> None:
        project = self.app.state.get_project()
        if not project:
            return self._error("Open a video first.", 409)
        if not project.get("captions_ready"):
            return self._error("The captions are not ready yet.", 409)
        try:
            at = float(query.get("t", "0"))
        except ValueError:
            at = 0.0
        at = max(0.0, min(float(project.get("duration") or 0), at))
        rev = int(project.get("ass_rev") or 0)
        key = (str(project.get("video_path")), round(at, 2), rev)

        with self.app._frame_lock:
            # Re-check under the lock so identical requests that arrived while
            # ffmpeg was busy find the cached frame instead of re-rendering.
            cached = self.app._frame_cache.get(key)
            if cached is None:
                # Only ever run ONE ffmpeg render at a time. Overlapping
                # preview refreshes (typing, style edits, timeline drags) used
                # to spawn several concurrent ffmpeg processes that hammer the
                # CPU and intermittently failed with 500s; identical requests
                # now just wait for the in-flight render and hit this cache.
                try:
                    jpeg = media.render_frame(
                        project["video_path"], project["work_dir"], at
                    )
                except media.ToolError as exc:
                    return self._error(str(exc), 500)
                except Exception as exc:  # noqa: BLE001
                    return self._error("Could not render the preview: %s" % exc, 500)
                self.app._frame_cache[key] = jpeg
                while len(self.app._frame_cache) > FRAME_CACHE_MAX:
                    self.app._frame_cache.pop(next(iter(self.app._frame_cache)))
                cached = jpeg
        self._send(200, cached, "image/jpeg")

    # -- API: video streaming ---------------------------------------------
    def _stream_video(self, route: str) -> None:
        project = self.app.state.get_project()
        if not project:
            return self._error("Open a video first.", 409)
        if route == "/api/result":
            target = project.get("export_path")
            if not target or not Path(target).exists():
                return self._error("There is no exported video yet.", 404)
        else:
            proxy = Path(project["work_dir"]) / tasks.PROXY_MP4
            if project.get("needs_proxy") and proxy.exists():
                target = str(proxy)
            else:
                target = project["video_path"]
            if not Path(target).exists():
                return self._error("The video file has moved or been deleted.", 404)
        self._stream_file(str(target))

    def _stream_file(self, target: str) -> None:
        try:
            size = os.path.getsize(target)
        except OSError:
            return self._error("Could not open the video file.", 404)
        ctype = mimetypes.guess_type(target)[0]
        if not ctype or not ctype.startswith("video/"):
            ctype = "video/mp4"

        start, end, code = 0, size - 1, 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
            if match:
                first, last = match.group(1), match.group(2)
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                elif last:
                    start = max(0, size - int(last))
                    end = size - 1
                if start >= size:
                    return self._send(
                        416, b"", ctype,
                        {"Content-Range": "bytes */%d" % size},
                    )
                end = min(end, size - 1)
                code = 206

        length = max(0, end - start + 1)
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            if code == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            with open(target, "rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except ConnectionError:
            pass

    # -- API: jobs ---------------------------------------------------------
    def _export(self) -> None:
        project = self.app.state.get_project()
        if not project:
            return self._error("Open a video first.")
        if not project.get("captions_ready"):
            return self._error("There are no captions to export yet.")
        out_path = tasks.default_export_path(project["video_path"])
        self.app.state.update_project(export_path=out_path, export_done=False)
        try:
            job = self.app.jobs.start(
                "export", tasks.export_stages(),
                lambda j: tasks.export_task(j, self.app.state),
            )
        except BusyError as exc:
            return self._error(str(exc), 409)
        self._json({"job": job.to_dict()})

    def _cancel(self) -> None:
        ok = self.app.jobs.cancel_current()
        self._json({"cancelled": ok})

    def _reset(self) -> None:
        job = self.app.jobs.current
        if job and job.active:
            return self._error("Cancel the current task first.", 409)
        self.app.state.clear_project()
        self._json({"ok": True})

    # -- API: misc ---------------------------------------------------------
    def _action(self, body: Dict[str, Any]) -> None:
        action = str(body.get("action") or "")
        project = self.app.state.get_project() or {}
        requested = str(body.get("path") or "")
        allowed = {
            project.get("video_path", ""),
            project.get("export_path") or "",
            project.get("work_dir", ""),
        }
        target = requested if requested in allowed else (project.get("export_path")
                                                         or project.get("video_path"))
        if not target:
            return self._error("Nothing to open yet.")
        if action == "reveal":
            ok = media.reveal_in_folder(str(target))
        elif action == "open":
            ok = media.open_with_default_app(str(target))
        else:
            return self._error("Unknown action.")
        self._json({"ok": bool(ok)})


def make_server(state: AppState, jobs: JobManager, static_dir: Path,
                port: int = 0) -> StudioServer:
    return StudioServer(("127.0.0.1", port), state, jobs, static_dir)
