"""
tasks.py -- the actual workflow steps that run as background jobs:
  extract audio -> transcribe (whisper) -> review SRT -> SRT to ASS
  and the final burn-in export.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

import asslib
import media
from jobs import Job
from state import AppState

AUDIO_WAV = "audio.wav"
AUDIO_SRT = "audio.srt"
AUDIO_ASS = "audio.ass"
PROXY_MP4 = "preview.mp4"


def atomic_write(path: Path, data: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    os.replace(str(tmp), str(path))


def process_stages(project: Dict) -> List[Dict]:
    stages: List[Dict] = []
    if project.get("needs_proxy"):
        stages.append({"key": "proxy", "label": "Prepare video preview"})
    stages += [
        {"key": "extract", "label": "Extract the audio (ffmpeg)"},
        {"key": "transcribe", "label": "Transcribe the speech (whisper-ctranslate2)"},
        {"key": "review", "label": "Review and fix the captions"},
        {"key": "convert", "label": "Build the editable caption file"},
    ]
    return stages


def export_stages() -> List[Dict]:
    return [{"key": "export", "label": "Burn the captions into the video"}]


def process_task(job: Job, state: AppState) -> Dict:
    project = state.get_project() or {}
    work = Path(project["work_dir"])
    video = project["video_path"]
    duration = float(project.get("duration") or 0.0)
    width = int(project.get("width") or 1280)
    height = int(project.get("height") or 720)

    # -- step: browser-friendly preview copy (only when the original codec
    #    cannot be played by the browser; export always uses the original) --
    if project.get("needs_proxy"):
        job.set_stage("proxy", "Making a preview copy the browser can play…", 0.0)
        proxy_path = work / PROXY_MP4
        stale = (
            not proxy_path.exists()
            or proxy_path.stat().st_mtime < Path(video).stat().st_mtime - 1
        )
        if not stale:
            job.log_line("Preview copy already exists, reusing it.")
        else:
            def proxy_progress(seconds: float) -> None:
                if duration > 0:
                    job.set_progress(min(0.99, seconds / duration))

            rc, tail = media.run_command(
                media.proxy_cmd(video, str(proxy_path)),
                cwd=str(work),
                on_line=job.log_line,
                on_progress=proxy_progress,
                cancel=job.cancel_event,
                parse_out_time=True,
            )
            if rc != 0 or not proxy_path.exists():
                raise RuntimeError(_fail_text("Could not create the preview copy", tail))
            job.log_line("Preview copy ready.")

    # -- step 1: extract the audio -----------------------------------------
    job.set_stage("extract", "ffmpeg is extracting the audio track…", None)
    job.log_line("$ ffmpeg -i video -vn -ac 1 -ar 16000 audio.wav")
    rc, tail = media.run_command(
        media.extract_audio_cmd(video),
        cwd=str(work),
        on_line=job.log_line,
        cancel=job.cancel_event,
    )
    wav = work / AUDIO_WAV
    if rc != 0 or not wav.exists() or wav.stat().st_size < 128:
        raise RuntimeError(_fail_text("Could not extract the audio from the video", tail))
    job.log_line("audio.wav created (%.1f MB)." % (wav.stat().st_size / 1048576.0))

    # -- step 2: transcribe with whisper ------------------------------------
    job.set_stage(
        "transcribe",
        "Whisper is transcribing the speech (model: small). "
        "Long videos can take several minutes on a laptop CPU…",
        None,
    )
    job.log_line("$ whisper-ctranslate2 audio.wav --model small --output_format srt "
                 "--word_timestamps True --temperature 0 --max_line_width 30 "
                 "--max_line_count 1 --language en")
    rc, tail = media.run_command(
        media.whisper_cmd(),
        cwd=str(work),
        on_line=job.log_line,
        cancel=job.cancel_event,
    )
    srt_path = work / AUDIO_SRT
    if rc != 0 or not srt_path.exists():
        raise RuntimeError(_fail_text("Whisper could not transcribe the audio", tail))
    job.log_line("audio.srt created.")

    # -- step 3: review the SRT --------------------------------------------
    job.set_stage("review", "Checking timings and fixing overlaps…", None)
    raw = srt_path.read_text(encoding="utf-8", errors="replace")
    cues = asslib.parse_srt(raw)
    if not cues:
        raise RuntimeError(
            "The transcription came back empty — no speech was detected in this video."
        )
    cues = asslib.normalize_cues(cues, duration=duration or None)
    atomic_write(srt_path, asslib.format_srt(cues))
    job.log_line("Reviewed %d captions (sorted, overlaps removed, clipped to the video)."
                 % len(cues))

    # -- step 4: SRT -> ASS -------------------------------------------------
    job.set_stage("convert", "Converting the captions to an editable .ass file…", None)
    rc, tail = media.run_command(
        media.srt_to_ass_cmd(),
        cwd=str(work),
        on_line=job.log_line,
        cancel=job.cancel_event,
    )
    ass_path = work / AUDIO_ASS
    text = ""
    if rc == 0 and ass_path.exists():
        text = ass_path.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        job.log_line("ffmpeg could not convert the file; building the .ass directly.")
        text = asslib.build_ass(cues, width, height)

    doc = asslib.AssDoc(text)
    dialogues = doc.dialogues()
    if not dialogues:
        raise RuntimeError("The caption file could not be created (no dialogue lines).")
    if doc.get_style() is None:
        # style section missing or broken -> regenerate cleanly
        text = asslib.build_ass([{"start": c["start"], "end": c["end"], "text": c["text"]}
                                 for c in dialogues], width, height)
        doc = asslib.AssDoc(text)
    if doc.scale_to_video(width, height):
        job.log_line("Matched the caption file to the video size (%dx%d)." % (width, height))
    atomic_write(ass_path, doc.text)
    job.log_line("audio.ass ready with %d captions." % len(doc.dialogues()))

    rev = int((state.get_project() or {}).get("ass_rev") or 0) + 1
    state.update_project(
        captions_ready=True,
        ass_rev=rev,
        srt_exists=True,
    )
    return {"captions": len(doc.dialogues()), "ass_rev": rev}


def export_task(job: Job, state: AppState) -> Dict:
    project = state.get_project() or {}
    if not project.get("captions_ready"):
        raise RuntimeError("There are no captions to export yet.")
    work = Path(project["work_dir"])
    ass_path = work / AUDIO_ASS
    if not ass_path.exists():
        raise RuntimeError("The caption file (audio.ass) is missing.")

    video = project["video_path"]
    out_path = project.get("export_path") or default_export_path(video)
    duration = float(project.get("duration") or 0.0)

    job.set_stage("export", "ffmpeg is burning the captions into the video…", 0.0)
    job.log_line("$ ffmpeg -i video -vf \"subtitles=filename=audio.ass\" -c:v libx264 "
                 "-preset medium -crf 17 -profile:v high -pix_fmt yuv420p "
                 "-c:a copy -movflags +faststart %s" % Path(out_path).name)
    state.update_project(export_path=out_path, export_done=False)

    def progress(seconds: float) -> None:
        if duration > 0:
            job.set_progress(min(0.99, seconds / duration))

    rc, tail = media.run_command(
        media.export_cmd(
            video, out_path,
            project.get("acodec"),
            bool(project.get("has_audio")),
            int(project.get("width") or 0),
            int(project.get("height") or 0),
        ),
        cwd=str(work),
        on_line=job.log_line,
        on_progress=progress,
        cancel=job.cancel_event,
        parse_out_time=True,
    )
    if rc != 0 or not Path(out_path).exists() or Path(out_path).stat().st_size < 1024:
        raise RuntimeError(_fail_text("The export failed", tail))

    size_mb = Path(out_path).stat().st_size / 1048576.0
    job.log_line("Exported %s (%.1f MB)." % (Path(out_path).name, size_mb))
    state.update_project(export_path=out_path, export_done=True)
    return {"path": out_path, "size_mb": round(size_mb, 1)}


def default_export_path(video_path: str) -> str:
    # The export command uses MP4-specific flags (-movflags +faststart) and
    # mp4-safe audio, so the result is always an .mp4 regardless of the source.
    p = Path(video_path)
    return str(p.with_name(p.stem + "_captioned.mp4"))


def _fail_text(headline: str, tail: List[str]) -> str:
    lines = [l for l in tail if l.strip()][-6:]
    if not lines:
        return headline + "."
    return headline + ":\n" + "\n".join(lines)
