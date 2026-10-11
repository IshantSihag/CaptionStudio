"""
media.py -- everything that touches the outside world for Caption Studio:
tool discovery, the native file dialog, media probing, and the exact
ffmpeg / whisper-ctranslate2 commands from the workflow.
"""

from __future__ import annotations

import glob
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")
IS_LINUX = sys.platform.startswith("linux")

VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv",
}

# Containers/codecs browsers can play directly (used for the live preview only;
# export always runs on the original file).
BROWSER_CONTAINERS = {".mp4", ".m4v", ".mov"}


class Cancelled(Exception):
    """Raised when the user cancels a running job."""


class ToolError(Exception):
    """Raised when a required external tool is missing or fails."""


# ---------------------------------------------------------------------------
# environment / tool discovery
# ---------------------------------------------------------------------------

def enriched_path() -> str:
    """Finder-launched apps (and .app bundles) get a very small $PATH, so we
    prepend the usual places Homebrew, pip --user, pipx and pyenv install to."""
    parts: List[str] = []
    home = str(Path.home())
    if IS_MAC:
        parts += [
            "/opt/homebrew/bin", "/opt/homebrew/sbin",
            "/usr/local/bin", "/usr/local/sbin",
            "/opt/local/bin",
        ]
    parts += [
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".pyenv", "bin"),
        os.path.join(home, ".pyenv", "shims"),
        str(Path(sys.executable).parent),
        str(Path(sys.executable).parent / "Scripts"),
    ]
    parts += glob.glob(os.path.join(home, "Library", "Python", "*", "bin"))
    parts += glob.glob(os.path.join(os.environ.get("APPDATA", ""), "Python", "Python*", "Scripts"))
    existing = os.environ.get("PATH", "")
    seen = set()
    merged: List[str] = []
    for p in parts + existing.split(os.pathsep):
        if p and p not in seen:
            seen.add(p)
            merged.append(p)
    return os.pathsep.join(merged)


def child_env() -> Dict[str, str]:
    env = dict(os.environ)
    env["PATH"] = enriched_path()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def find_tool(name: str) -> Optional[str]:
    return shutil.which(name, path=enriched_path())


def tool_report() -> Dict:
    """Checks the tools the workflow depends on and explains how to install
    anything that is missing (the GUI shows these hints verbatim)."""
    ffmpeg = find_tool("ffmpeg")
    ffprobe = find_tool("ffprobe")
    whisper = find_tool("whisper-ctranslate2")

    items = [
        {
            "key": "ffmpeg",
            "name": "ffmpeg",
            "ok": bool(ffmpeg),
            "path": ffmpeg,
            "hint_mac": "Install it with Homebrew:  brew install ffmpeg",
            "hint_win": "Install it with:  winget install Gyan.FFmpeg",
            "hint_linux": "Install it with:  sudo apt install ffmpeg",
        },
        {
            "key": "whisper",
            "name": "whisper-ctranslate2",
            "ok": bool(whisper),
            "path": whisper,
            "hint_mac": "Install it with:  python3 -m pip install -U whisper-ctranslate2",
            "hint_win": "Install it with:  pip install -U whisper-ctranslate2",
            "hint_linux": "Install it with:  python3 -m pip install -U whisper-ctranslate2",
        },
    ]
    return {
        "ok": all(i["ok"] for i in items),
        "ffprobe": ffprobe,
        "items": items,
    }


# ---------------------------------------------------------------------------
# probing
# ---------------------------------------------------------------------------

def probe_video(path: str) -> Dict:
    """Returns duration / size / codecs for a video. Uses ffprobe when it is
    there and falls back to reading ffmpeg's banner otherwise."""
    path = str(path)
    ffprobe = find_tool("ffprobe")
    if ffprobe:
        cmd = [
            ffprobe, "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", path,
        ]
        try:
            proc = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=60, env=child_env(),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if proc.returncode == 0:
                data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
                return _probe_from_json(data, path)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass

    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise ToolError("ffmpeg was not found, so the video cannot be inspected.")
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=60, env=child_env(),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    text = proc.stderr.decode("utf-8", "replace")
    dur = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", text)
    video_line = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", text)
    audio_line = re.search(r"Audio:\s*([a-z0-9_]+)", text)
    if not dur:
        raise ValueError("That file does not look like a valid video.")
    duration = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3))
    if not video_line:
        raise ValueError("No video stream was found in that file.")
    width, height = int(video_line.group(1)), int(video_line.group(2))
    acodec = audio_line.group(1).lower() if audio_line else None
    vcodec_match = re.search(r"Video:\s*([a-z0-9_]+)", text)
    vcodec = vcodec_match.group(1).lower() if vcodec_match else None
    container = Path(path).suffix.lower()
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "vcodec": vcodec,
        "acodec": acodec,
        "has_video": True,
        "container": container,
        "web_safe": _is_web_safe(container, vcodec, acodec),
    }


def _probe_from_json(data: Dict, path: str) -> Dict:
    streams = data.get("streams") or []
    vcodec = acodec = None
    width = height = None
    for s in streams:
        if s.get("codec_type") == "video" and width is None and s.get("width"):
            width, height = int(s["width"]), int(s["height"])
            vcodec = (s.get("codec_name") or "").lower()
        elif s.get("codec_type") == "audio" and acodec is None:
            acodec = (s.get("codec_name") or "").lower()
    duration = 0.0
    try:
        duration = float((data.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if not duration:
        for s in streams:
            try:
                duration = max(duration, float(s.get("duration") or 0))
            except (TypeError, ValueError):
                pass
    if width is None:
        raise ValueError("No video stream was found in that file.")
    if duration <= 0:
        raise ValueError("Could not work out the length of that video.")
    container = Path(path).suffix.lower()
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "vcodec": vcodec,
        "acodec": acodec,
        "has_video": True,
        "container": container,
        "web_safe": _is_web_safe(container, vcodec, acodec),
    }


def _is_web_safe(container: str, vcodec: Optional[str], acodec: Optional[str]) -> bool:
    if container not in BROWSER_CONTAINERS:
        return False
    if vcodec and vcodec != "h264":
        return False
    if acodec and acodec not in ("aac", "alac"):
        return False
    return True


def export_audio_args(acodec: Optional[str], has_audio: bool) -> List[str]:
    """' -c:a copy' when the source audio already fits in an MP4, otherwise
    a safe AAC transcode (copying incompatible audio would fail the export)."""
    if not has_audio:
        return []
    if acodec in ("aac", "alac"):
        return ["-c:a", "copy"]
    return ["-c:a", "aac", "-b:a", "192k"]


# ---------------------------------------------------------------------------
# native file dialog
# ---------------------------------------------------------------------------

DIALOG_CANCELLED = "cancelled"
DIALOG_UNAVAILABLE = "unavailable"


def pick_video() -> Tuple[str, Optional[str]]:
    """Opens the platform's own file picker.
    Returns (status, path) where status is 'ok' | 'cancelled' | 'unavailable'."""
    if IS_MAC:
        script = (
            'POSIX path of (choose file with prompt '
            '"Choose the video you want to add captions to")'
        )
        try:
            proc = subprocess.run(
                ["osascript", "-e", script],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=300, env=child_env(),
            )
        except (OSError, subprocess.TimeoutExpired):
            return DIALOG_UNAVAILABLE, None
        if proc.returncode == 0:
            path = proc.stdout.decode("utf-8", "replace").strip()
            return ("ok", path) if path else (DIALOG_CANCELLED, None)
        err = proc.stderr.decode("utf-8", "replace")
        if "User canceled" in err or "-128" in err:
            return DIALOG_CANCELLED, None
        return DIALOG_UNAVAILABLE, err.strip() or "The file dialog could not be opened."

    if not IS_MAC:
        code = (
            "import tkinter as tk\n"
            "from tkinter import filedialog\n"
            "root = tk.Tk()\n"
            "root.withdraw()\n"
            "root.attributes('-topmost', True)\n"
            "print(filedialog.askopenfilename(\n"
            "    title='Choose the video you want to add captions to',\n"
            "    filetypes=[('Video files', '*.mp4 *.mov *.m4v *.mkv *.webm *.avi "
            "*.flv *.wmv *.mpg *.mpeg *.ts *.m2ts *.3gp *.ogv'), ('All files', '*.*')]))\n"
        )
        try:
            proc = subprocess.run(
                [sys.executable, "-c", code],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=300, env=child_env(),
            )
        except (OSError, subprocess.TimeoutExpired):
            return DIALOG_UNAVAILABLE, None
        out = proc.stdout.decode("utf-8", "replace").strip().splitlines()
        path = out[-1].strip() if out else ""
        if proc.returncode == 0 and path:
            return "ok", path
        if proc.returncode == 0:
            return DIALOG_CANCELLED, None
        err = proc.stderr.decode("utf-8", "replace").strip()
        return DIALOG_UNAVAILABLE, err or "The file dialog could not be opened."

    return DIALOG_UNAVAILABLE, None


def reveal_in_folder(path: str) -> bool:
    """Selects the file in Finder / Explorer."""
    path = str(path)
    try:
        if IS_MAC:
            subprocess.Popen(["open", "-R", path])
            return True
        if IS_WIN:
            subprocess.Popen('explorer /select,"%s"' % path.replace("/", "\\"))
            return True
        target = str(Path(path).parent)
        subprocess.Popen(["xdg-open", target])
        return True
    except OSError:
        return False


def open_with_default_app(path: str) -> bool:
    path = str(path)
    try:
        if IS_MAC:
            subprocess.Popen(["open", path])
        elif IS_WIN:
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", path])
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# running external commands
# ---------------------------------------------------------------------------

def _popen(cmd: List[str], cwd: Optional[str]) -> subprocess.Popen:
    kwargs = dict(
        args=cmd,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=child_env(),
        shell=False,
    )
    if IS_WIN:
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(**kwargs)


def run_command(
    cmd: List[str],
    cwd: Optional[str] = None,
    on_line: Optional[Callable[[str], None]] = None,
    on_progress: Optional[Callable[[float], None]] = None,
    cancel: Optional[threading.Event] = None,
    parse_out_time: bool = False,
    timeout: Optional[float] = None,
) -> Tuple[int, List[str]]:
    """Runs a command, streaming its combined output line by line.
    * on_line      -- every line (job log)
    * on_progress  -- seconds completed, parsed from `ffmpeg -progress pipe:1`
    * cancel       -- event that terminates the process when set
    Returns (returncode, recent tail)."""
    proc = _popen(cmd, cwd)
    chunks: "queue.Queue[Optional[bytes]]" = queue.Queue()

    def _reader() -> None:
        try:
            while True:
                data = proc.stdout.read1(1024) if proc.stdout else b""
                if not data:
                    break
                chunks.put(data)
        except OSError:
            pass
        finally:
            chunks.put(None)

    threading.Thread(target=_reader, daemon=True).start()

    tail: List[str] = []
    buffer = b""
    started = time.time()
    terminated = False
    out_time_re = re.compile(r"^out_time=(\d+):(\d{2}):(\d{2}\.?\d*)")

    def _handle(line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        tail.append(line)
        if len(tail) > 120:
            del tail[: len(tail) - 120]
        if on_line:
            on_line(line)
        if parse_out_time and on_progress:
            m = out_time_re.match(line)
            if m:
                h, mi, s = m.groups()
                on_progress(int(h) * 3600 + int(mi) * 60 + float(s))

    while True:
        if cancel is not None and cancel.is_set() and not terminated:
            terminate_process(proc)
            terminated = True
        if timeout and (time.time() - started) > timeout and not terminated:
            terminate_process(proc)
            terminated = True
        try:
            item = chunks.get(timeout=0.25)
        except queue.Empty:
            continue
        if item is None:
            break
        buffer += item
        while True:
            split_at = -1
            for sep in (b"\n", b"\r"):
                idx = buffer.find(sep)
                if idx != -1 and (split_at == -1 or idx < split_at):
                    split_at = idx
            if split_at == -1:
                break
            raw, buffer = buffer[:split_at], buffer[split_at + 1:]
            _handle(raw.decode("utf-8", "replace"))
    if buffer:
        _handle(buffer.decode("utf-8", "replace"))

    try:
        rc = proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        terminate_process(proc)
        rc = proc.wait(timeout=5)

    if terminated and cancel is not None and cancel.is_set():
        raise Cancelled()
    if terminated and timeout:
        raise RuntimeError("The command timed out.")
    return rc, tail


def terminate_process(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
    except OSError:
        return
    def _kill() -> None:
        try:
            if proc.poll() is None:
                proc.kill()
        except OSError:
            pass
    threading.Timer(4.0, _kill).start()


# ---------------------------------------------------------------------------
# command builders  (exactly the workflow commands)
# ---------------------------------------------------------------------------

def ffmpeg_bin() -> str:
    path = find_tool("ffmpeg")
    if not path:
        raise ToolError("ffmpeg is not installed (or not on the PATH).")
    return path


def whisper_bin() -> str:
    path = find_tool("whisper-ctranslate2")
    if not path:
        raise ToolError("whisper-ctranslate2 is not installed (or not on the PATH).")
    return path


def extract_audio_cmd(video_path: str) -> List[str]:
    """ffmpeg -i video.mp4 -vn -ac 1 -ar 16000 audio.wav"""
    return [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000", "audio.wav",
    ]


def whisper_cmd() -> List[str]:
    """whisper-ctranslate2 audio.wav --model small --output_format srt ..."""
    return [
        whisper_bin(), "audio.wav",
        "--model", "small",
        "--output_format", "srt",
        "--word_timestamps", "True",
        "--temperature", "0",
        "--max_line_width", "30",
        "--max_line_count", "1",
        "--language", "en",
        "--output_dir", ".",
    ]


def srt_to_ass_cmd() -> List[str]:
    """ffmpeg -i audio.srt audio.ass"""
    return [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", "audio.srt", "audio.ass",
    ]


def frame_cmd(video_path: str, at_sec: float) -> List[str]:
    """One frame of the original video with the current captions burned in --
    the same filter chain the export uses, so the preview is always exact.

    -copyts is REQUIRED here: without it, fast seeking (-ss before -i) resets
    the timestamps the `subtitles` filter sees back to ~0, so libass always
    burns the FIRST caption in the file regardless of the stopped position.
    With -copyts the subtitles stay on the real timeline."""
    return [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error",
        "-copyts",
        "-ss", "%.3f" % max(0.0, at_sec),
        "-i", str(video_path),
        "-an", "-sn",
        "-vf", "subtitles=filename=audio.ass",
        "-frames:v", "1", "-q:v", "4",
        "-f", "mjpeg", "pipe:1",
    ]


def export_cmd(
    video_path: str,
    out_path: str,
    acodec: Optional[str],
    has_audio: bool,
    width: int,
    height: int,
) -> List[str]:
    """ffmpeg -i video.mp4 -vf "subtitles=filename=audio.ass" -c:v libx264
    -preset medium -crf 17 -profile:v high -pix_fmt yuv420p -c:a copy
    -movflags +faststart final.mp4"""
    filter_graph = "subtitles=filename=audio.ass"
    if width % 2 or height % 2:
        # libx264 + yuv420p needs even dimensions
        filter_graph = "scale=trunc(iw/2)*2:trunc(ih/2)*2," + filter_graph
    return [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path),
        "-vf", filter_graph,
        "-c:v", "libx264", "-preset", "medium", "-crf", "17",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
    ] + export_audio_args(acodec, has_audio) + [
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        str(out_path),
    ]


def proxy_cmd(video_path: str, out_path: str) -> List[str]:
    """Small browser-friendly preview copy (only made when the original codec
    cannot play in a browser; the export always uses the original file)."""
    return [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path),
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        str(out_path),
    ]


def render_frame(video_path: str, work_dir: str, at_sec: float, timeout: float = 30.0) -> bytes:
    """Synchronous single-frame render; returns JPEG bytes."""
    cmd = frame_cmd(video_path, at_sec)
    try:
        proc = subprocess.run(
            cmd, cwd=work_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, env=child_env(),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Rendering the preview frame took too long.")
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(err[-1] if err else "Could not render the preview frame.")
    if not proc.stdout:
        raise RuntimeError("ffmpeg produced an empty preview frame.")
    return proc.stdout


def human_duration(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "%d:%02d:%02d" % (h, m, s)
    return "%d:%02d" % (m, s)
