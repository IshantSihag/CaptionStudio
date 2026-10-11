"""
run.py -- Caption Studio entry point.

Starts the local web server, opens the GUI in the default browser and keeps
running until the window/terminal is closed. Works three ways:
  * double-clicking CaptionStudio.command   (macOS)
  * the packaged "Caption Studio.app"       (built with build_app.sh)
  * python3 run.py                          (any platform)
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser
from pathlib import Path

import media
from jobs import JobManager
from server import make_server
from state import AppState


def resource_dir() -> Path:
    """Folder holding static/ — handles PyInstaller bundles too."""
    if getattr(sys, "frozen", False):  # packaged .app
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return base
    return Path(__file__).resolve().parent


def say(message: str) -> None:
    try:
        print(message, flush=True)
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Caption Studio")
    parser.add_argument("--port", type=int, default=0, help="TCP port (0 = pick a free one)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the web browser")
    args = parser.parse_args()

    static_dir = resource_dir() / "static"
    if not (static_dir / "index.html").exists():
        say("ERROR: the 'static' folder is missing next to %s" % __file__)
        return 1

    tools = media.tool_report()
    state = AppState()
    state.set_tools(tools)
    jobs = JobManager()

    server = make_server(state, jobs, static_dir, port=args.port)
    host, port = server.server_address[:2]
    url = "http://%s:%d/" % (host, port)

    say("")
    say("  Caption Studio is running")
    say("  Open this address in your browser: %s" % url)
    say("  Press Ctrl+C to quit.")
    say("")

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        say("Shutting down…")
    finally:
        job = jobs.current
        if job is not None and job.active:
            jobs.cancel_current()
            time.sleep(0.4)
        try:
            server.server_close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
