# Caption Studio

A simple local web app that adds captions to your videos — no coding, no upload,
nothing leaves your computer.

**How it works:** pick a video → Caption Studio extracts the audio, transcribes it
with Whisper, lets you fix the captions in a friendly editor (with a live,
pixel-exact preview of every frame), and burns them into a new video file with
ffmpeg.

Everything runs locally on your own Mac (or Windows/Linux PC).

---

## What you need

Caption Studio needs these two tools installed **once** on your computer:

| Tool | Install |
|---|---|
| **ffmpeg** | `brew install ffmpeg-full` (Mac) · `winget install ffmpeg` (Windows) · `sudo apt install ffmpeg` (Linux) |
| **whisper-ctranslate2** | `pip install whisper-ctranslate2` (or `pip3`) |

You also need **Python 3.9+** (https://www.python.org/downloads/).

If either tool is missing, Caption Studio will tell you right inside the app
with the message **“Installation for tools is not proper”** and instructions
for your operating system. Install them, click **Check again**, and continue.

Caption Studio itself has **no other dependencies** — no Flask, no Node, no
internet connection required.

---

## Quick start (macOS)

1. Copy the `CaptionStudio` folder anywhere on your Mac.
2. Double-click **`CaptionStudio.command`**.
   - First time only, if macOS blocks it: run once in Terminal
     `chmod +x CaptionStudio.command`, then double-click again.
3. Your default browser opens with the app (the address and port are printed
   in the Terminal window — the port is picked automatically so it never
   clashes with other programs).

Prefer a terminal? Run `python3 run.py` from the folder, or
`python3 run.py --no-browser --port 9000` to pick your own port.

### Optional: a real macOS app icon

On the Mac, run:

```bash
./build_app.sh
```

This installs PyInstaller and produces **`dist/Caption Studio.app`**.
First launch: right-click the app → **Open** (macOS security prompt for
unsigned apps).

---

## Using Caption Studio

1. **Choose your video** — browse for it, or paste its full path.
   The app probes it and prepares a preview copy if the browser cannot play
   the original format.
2. **Wait a moment** — three automatic stages:
   - *Extract the audio* (ffmpeg)
   - *Transcribe the speech* (whisper-ctranslate2, English, `small` model)
   - *Build the editable caption file* (SRT → ASS)
3. **Review and fix the captions** — the editor has:
   - **Captions** tab: one row per caption with start/end times and text.
     Buttons: **Go** (jump the video there), **S** (start = current time),
     **E** (end = current time), **✕** (delete, with Undo toast).
     Add a caption at the playhead with **+ Add caption**.
   - **Style** tab: font, size, colour, outline or box background (solid or
     transparent — the opacity slider controls whether you can see the video
     through the box), horizontal and vertical padding, position, margins.
     Each caption can also override the default with its own **Aa** panel
     (text colour, bold, italic).
   - **Raw file** tab: edit the `.ass` file directly.
   - The video shows the **exact frame ffmpeg will export**, with the captions
     burned on top the same way the export does. While playing, an HTML
     overlay keeps the captions visible.
   - Everything **auto-saves** as you type (you can also press Revert).
   - Space = play/pause, ← / → = seek 5 seconds.
4. **Export** — creates `<your-video>_captioned.mp4` next to your original
   video, using the same ffmpeg command the preview shows.

**Start over** (top bar) clears the current project. **Regenerate** throws
away your edits and re-runs the transcription.

---

## Where your files are

Next to your source video, a folder named `<video-name>_captions/` holds:

| File | What it is |
|---|---|
| `audio.wav` | mono 16 kHz audio extracted from your video |
| `audio.srt` | raw Whisper transcription |
| `audio.ass` | the caption file the editor edits (this is what gets burned in) |
| `preview.mp4` | browser-playable preview copy (only for unusual formats) |

The exported video is written next to the source video as
`<video-name>_captioned.mp4`.

Caption Studio keeps everything in memory while it runs — there is no hidden
settings file, and nothing is written outside your video’s folder.

---

## Troubleshooting

**“Installation for tools is not proper”**
ffmpeg and/or whisper-ctranslate2 were not found. Install them (table above),
make sure your terminal/PATH was restarted, then click **Check again**.

**The app window doesn’t open**
Run `python3 run.py --no-browser` and open the address it prints manually.

**Transcription is slow / computer fans spin up**
Whisper’s `small` model runs on the CPU. A 10-minute video can take several
minutes. The log in the app shows live progress.

**Captions are in the wrong language**
The current build transcribes English (`--language en`). Change the language in
`tasks.py` (the whisper command) if you need another one.

**The preview video won’t play (black player)**
The app usually auto-creates a browser-friendly preview copy. If playback still
fails, your exported file is unaffected — ffmpeg reads the original directly.

**“Port already in use”**
Another program is using the port you asked for — pick a different one:
`python3 run.py --port 8766`
(With no `--port` argument, a free port is chosen automatically.)

**Export failed / captions look wrong**
Open the **Raw file** tab and check `audio.ass`. You can also run the exact
export command by hand — it is printed in the log — to see ffmpeg’s full error.

**macOS: “cannot be opened because the developer cannot be verified”**
Right-click → Open → Open. This applies to both `CaptionStudio.command` and a
built `.app`.

---

## For developers

```
CaptionStudio/
├── run.py        entry point: starts the server, opens the browser
├── server.py     stdlib ThreadingHTTPServer + JSON API + file streaming
├── tasks.py      pipeline jobs: extract → whisper → srt→ass → export
├── media.py      ffmpeg/whisper command builders, probing, tool detection
├── asslib.py     SRT/ASS parsing, building, style scaling
├── jobs.py       job queue, progress, log streaming
├── state.py      project persistence (~/.captionstudio/)
└── static/       index.html · style.css · app.js (editor UI, no framework)
```

Run the local test suite for the in-browser ASS toolkit with Node:

```bash
node _make_ass_test.js && node _ass_test.gen.js
```

No build step is required for the web UI — `static/` is served as-is.
