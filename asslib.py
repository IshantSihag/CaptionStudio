"""
asslib.py -- small subtitle toolkit for Caption Studio.

Covers everything the app needs around text:
  * reading / writing / reviewing SRT files
  * parsing and rebuilding ASS files without losing anything the user wrote
  * scaling ffmpeg's default ASS output to the real video resolution so that
    style values (font size, outline, margins) are true pixels
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# time helpers
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(r"^(\d+):(\d{1,2}):(\d{2})[.,](\d{1,3})$")
_TIME_SHORT_RE = re.compile(r"^(\d{1,2}):(\d{2})[.,](\d{1,3})$")


def parse_time(value: str) -> float:
    """Accepts SRT '00:01:02,500', ASS '0:01:02.50' and bare '62.5'."""
    v = (value or "").strip()
    m = _TIME_RE.match(v)
    if m:
        h, mi, s, frac = m.groups()
        frac = (frac + "000")[:3]
        return int(h) * 3600 + int(mi) * 60 + int(s) + int(frac) / 1000.0
    m = _TIME_SHORT_RE.match(v)
    if m:
        mi, s, frac = m.groups()
        frac = (frac + "000")[:3]
        return int(mi) * 60 + int(s) + int(frac) / 1000.0
    try:
        return float(v)
    except ValueError:
        raise ValueError("Unrecognised timestamp: %r" % value)


def fmt_srt(sec: float) -> str:
    total_ms = max(0, int(round(sec * 1000)))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def fmt_ass(sec: float) -> str:
    total_cs = max(0, int(round(sec * 100)))
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return "%d:%02d:%02d.%02d" % (h, m, s, cs)


# ---------------------------------------------------------------------------
# SRT
# ---------------------------------------------------------------------------

def parse_srt(text: str) -> List[Dict]:
    cues: List[Dict] = []
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return cues
    for block in re.split(r"\n\s*\n", text):
        lines = block.split("\n")
        arrow = None
        for i, line in enumerate(lines):
            if "-->" in line:
                arrow = i
                break
        if arrow is None:
            continue
        left, right = lines[arrow].split("-->", 1)
        try:
            start = parse_time(left.split()[0])
            end = parse_time(right.split()[0])
        except (ValueError, IndexError):
            continue
        body = "\n".join(lines[arrow + 1:]).strip("\n")
        cues.append({"start": start, "end": end, "text": body})
    return cues


def format_srt(cues: List[Dict]) -> str:
    parts = []
    for i, c in enumerate(cues, 1):
        parts.append(
            "%d\n%s --> %s\n%s"
            % (i, fmt_srt(c["start"]), fmt_srt(c["end"]), (c["text"] or "").strip())
        )
    return "\n\n".join(parts) + ("\n" if parts else "")


def normalize_cues(cues: List[Dict], duration: Optional[float] = None) -> List[Dict]:
    """Review pass: sort, drop empties, keep times inside the video and
    remove overlapping captions (the previous caption is trimmed)."""
    items = []
    for c in cues:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(c["start"])
            end = float(c["end"])
        except (TypeError, ValueError):
            continue
        items.append({"start": start, "end": end, "text": text})
    items.sort(key=lambda c: c["start"])

    out: List[Dict] = []
    for c in items:
        c["start"] = max(0.0, c["start"])
        if duration:
            c["end"] = min(c["end"], float(duration))
        if c["end"] <= c["start"]:
            continue
        if out and c["start"] < out[-1]["end"]:
            out[-1]["end"] = c["start"]
            if out[-1]["end"] <= out[-1]["start"]:
                out.pop()
        if out and c["start"] < out[-1]["end"]:
            c["start"] = out[-1]["end"]
            if c["end"] <= c["start"]:
                continue
        out.append(c)
    return out


# ---------------------------------------------------------------------------
# ASS
# ---------------------------------------------------------------------------

DEFAULT_EVENTS_FORMAT = [
    "Layer", "Start", "End", "Style", "Name",
    "MarginL", "MarginR", "MarginV", "Effect", "Text",
]

DEFAULT_STYLE_FORMAT = [
    "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour",
    "OutlineColour", "BackColour", "Bold", "Italic", "Underline", "StrikeOut",
    "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle", "Outline", "Shadow",
    "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
]

# Style fields that are plain sizes and must scale with the script resolution.
SCALABLE_STYLE_FIELDS = (
    "Fontsize", "Outline", "Shadow", "Spacing", "MarginL", "MarginR", "MarginV",
)


def build_ass(cues: List[Dict], width: int, height: int) -> str:
    """Fallback ASS writer (used if ffmpeg cannot convert the SRT for us).
    Produces the same look as ffmpeg's default conversion, but with the real
    video resolution so values are true pixels."""
    fontsize = max(8, int(round(height * 16 / 288.0)))
    outline = max(1, int(round(height * 1.0 / 288.0)))
    margin = max(4, int(round(height * 10 / 288.0)))
    lines = [
        "[Script Info]",
        "; Generated by Caption Studio",
        "ScriptType: v4.00+",
        "PlayResX: %d" % width,
        "PlayResY: %d" % height,
        "ScaledBorderAndShadow: yes",
        "WrapStyle: 0",
        "",
        "[V4+ Styles]",
        "Format: " + ", ".join(DEFAULT_STYLE_FORMAT),
        "Style: Default,Arial,%d,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,"
        "0,0,0,0,100,100,0,0,1,%d,0,2,%d,%d,%d,1"
        % (fontsize, outline, margin, margin, margin),
        "",
        "[Events]",
        "Format: " + ", ".join(DEFAULT_EVENTS_FORMAT),
    ]
    for c in cues:
        lines.append(
            "Dialogue: 0,%s,%s,Default,,0,0,0,,%s"
            % (fmt_ass(c["start"]), fmt_ass(c["end"]), c.get("text") or "")
        )
    return "\n".join(lines) + "\n"


class AssDoc:
    """Light-weight ASS document: reads dialogues and styles, and can rewrite
    them while keeping every other line the user typed in the raw editor."""

    def __init__(self, text: str):
        text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
        self.lines = text.split("\n")

    # -- basics ------------------------------------------------------------
    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    @staticmethod
    def _find_line(lines: List[str], needle: str) -> Optional[int]:
        low = needle.lower()
        for i, line in enumerate(lines):
            if line.strip().lower() == low:
                return i
        return None

    def _section_bounds(self, name: str):
        start = self._find_line(self.lines, name)
        if start is None:
            return None
        end = len(self.lines)
        for i in range(start + 1, len(self.lines)):
            if self.lines[i].strip().startswith("[") and self.lines[i].strip().endswith("]"):
                end = i
                break
        return start, end

    def _find_format(self, sec_start: int, sec_end: int) -> Optional[int]:
        for i in range(sec_start + 1, sec_end):
            if self.lines[i].strip().lower().startswith("format:"):
                return i
        return None

    @staticmethod
    def _fields(header_line: str, default: List[str]) -> List[str]:
        try:
            raw = header_line.split(":", 1)[1]
        except IndexError:
            return list(default)
        fields = [f.strip() for f in raw.split(",")]
        return fields if any(fields) else list(default)

    # -- script info -------------------------------------------------------
    def get_info(self, key: str, default: Optional[str] = None) -> Optional[str]:
        bounds = self._section_bounds("[Script Info]")
        if not bounds:
            return default
        low = key.lower() + ":"
        for i in range(bounds[0] + 1, bounds[1]):
            line = self.lines[i]
            if line.lower().startswith(low):
                return line.split(":", 1)[1].strip()
        return default

    def set_info(self, key: str, value: str) -> None:
        bounds = self._section_bounds("[Script Info]")
        if not bounds:
            self.lines = ["[Script Info]", "%s: %s" % (key, value), ""] + self.lines
            return
        low = key.lower() + ":"
        for i in range(bounds[0] + 1, bounds[1]):
            if self.lines[i].lower().startswith(low):
                self.lines[i] = "%s: %s" % (key, value)
                return
        # insert just after the section header (keeps ffmpeg's ordering tidy)
        self.lines.insert(bounds[0] + 1, "%s: %s" % (key, value))

    # -- styles ------------------------------------------------------------
    def _styles_bounds(self):
        return self._section_bounds("[V4+ Styles]") or self._section_bounds("[V4 Styles]")

    def _style_lines(self):
        """(format_index, [(line_index, fields_dict), ...]) or None."""
        bounds = self._styles_bounds()
        if not bounds:
            return None
        fmt_idx = self._find_format(bounds[0], bounds[1])
        fields = (
            self._fields(self.lines[fmt_idx], DEFAULT_STYLE_FORMAT)
            if fmt_idx is not None
            else list(DEFAULT_STYLE_FORMAT)
        )
        styles = []
        for i in range((fmt_idx if fmt_idx is not None else bounds[0]) + 1, bounds[1]):
            line = self.lines[i]
            if not line.strip().lower().startswith("style:"):
                continue
            payload = line.split(":", 1)[1].lstrip(" ")
            parts = payload.split(",", len(fields) - 1)
            if len(parts) < len(fields):
                parts += [""] * (len(fields) - len(parts))
            styles.append((i, dict(zip(fields, parts))))
        if not styles:
            return None
        return fmt_idx, fields, styles

    def style_names(self) -> List[str]:
        info = self._style_lines()
        if not info:
            return []
        return [s[1].get("Name", "Default") for s in info[2]]

    def get_style(self, name: Optional[str] = None) -> Optional[Dict[str, str]]:
        info = self._style_lines()
        if not info:
            return None
        _, _, styles = info
        if name:
            for _, data in styles:
                if data.get("Name") == name:
                    return data
        return styles[0][1]

    def set_style(self, name: Optional[str], updates: Dict[str, str]) -> bool:
        info = self._style_lines()
        if not info:
            return False
        _, fields, styles = info
        target = None
        if name:
            for idx, data in styles:
                if data.get("Name") == name:
                    target = (idx, data)
                    break
        if target is None:
            target = styles[0]
        idx, data = target
        data.update(updates)
        ordered = [data.get(f, "") for f in fields]
        self.lines[idx] = "Style: " + ",".join(ordered)
        return True

    # -- dialogues ---------------------------------------------------------
    def dialogues(self) -> List[Dict]:
        bounds = self._section_bounds("[Events]")
        if not bounds:
            return []
        fmt_idx = self._find_format(bounds[0], bounds[1])
        fields = (
            self._fields(self.lines[fmt_idx], DEFAULT_EVENTS_FORMAT)
            if fmt_idx is not None
            else list(DEFAULT_EVENTS_FORMAT)
        )
        out: List[Dict] = []
        for i in range((fmt_idx if fmt_idx is not None else bounds[0]) + 1, bounds[1]):
            line = self.lines[i]
            if not line.strip().lower().startswith("dialogue:"):
                continue
            payload = line.split(":", 1)[1].lstrip(" ")
            parts = payload.split(",", len(fields) - 1)
            if len(parts) < len(fields):
                parts += [""] * (len(fields) - len(parts))
            data = dict(zip(fields, parts))
            try:
                start = parse_time(data.get("Start", ""))
                end = parse_time(data.get("End", ""))
            except ValueError:
                continue
            extras = {k: v for k, v in data.items() if k not in ("Start", "End", "Text")}
            out.append(
                {
                    "index": i,
                    "start": start,
                    "end": end,
                    "text": data.get("Text", ""),
                    "style": data.get("Style", "Default"),
                    "extras": extras,
                }
            )
        return out

    def replace_dialogues(self, cues: List[Dict]) -> None:
        bounds = self._section_bounds("[Events]")
        style_names = self.style_names()
        default_style = style_names[0] if style_names else "Default"

        if not bounds:
            header = ["[Events]"]
            header.append("Format: " + ", ".join(DEFAULT_EVENTS_FORMAT))
            for c in cues:
                header.append(self._compose_dialogue(c, list(DEFAULT_EVENTS_FORMAT), default_style))
            if self.lines and self.lines[-1] != "":
                self.lines.append("")
            self.lines.extend(header)
            return

        fmt_idx = self._find_format(bounds[0], bounds[1])
        fields = (
            self._fields(self.lines[fmt_idx], DEFAULT_EVENTS_FORMAT)
            if fmt_idx is not None
            else list(DEFAULT_EVENTS_FORMAT)
        )
        first_ev: Optional[int] = None
        last_ev: Optional[int] = None
        for i in range((fmt_idx if fmt_idx is not None else bounds[0]) + 1, bounds[1]):
            low = self.lines[i].strip().lower()
            if low.startswith("dialogue:") or low.startswith("comment:"):
                if first_ev is None:
                    first_ev = i
                last_ev = i

        new_events = [self._compose_dialogue(c, fields, default_style) for c in cues]

        if first_ev is None or last_ev is None:
            insert_at = (fmt_idx if fmt_idx is not None else bounds[0]) + 1
            self.lines[insert_at:insert_at] = new_events
            return

        head = self.lines[:first_ev]
        tail = self.lines[last_ev + 1:]
        self.lines = head + new_events + tail

    @staticmethod
    def _compose_dialogue(cue: Dict, fields: List[str], default_style: str) -> str:
        extras = dict(cue.get("extras") or {})
        values = []
        for f in fields:
            if f == "Start":
                values.append(fmt_ass(float(cue["start"])))
            elif f == "End":
                values.append(fmt_ass(float(cue["end"])))
            elif f == "Text":
                values.append(cue.get("text") or "")
            elif f == "Layer":
                values.append(extras.get("Layer", "0"))
            elif f == "Style":
                values.append(extras.get("Style") or cue.get("style") or default_style)
            elif f in ("MarginL", "MarginR", "MarginV"):
                values.append(extras.get(f, "0"))
            elif f == "Name":
                values.append(extras.get("Name", ""))
            elif f == "Effect":
                values.append(extras.get("Effect", ""))
            else:
                values.append(extras.get(f, ""))
        return "Dialogue: " + ",".join(values)

    # -- resolution scaling ------------------------------------------------
    def scale_to_video(self, width: int, height: int) -> bool:
        """Point PlayRes at the real video size and rescale the style values
        so the rendered look stays identical while numbers become true pixels."""
        try:
            old_h = float(self.get_info("PlayResY") or 288)
            old_w = float(self.get_info("PlayResX") or 384)
        except ValueError:
            old_h, old_w = 288.0, 384.0
        if int(old_h) == int(height) and int(old_w) == int(width):
            return False

        ratio = float(height) / old_h if old_h else 1.0
        self.set_info("PlayResX", str(int(width)))
        self.set_info("PlayResY", str(int(height)))
        if (self.get_info("ScaledBorderAndShadow") or "").lower() != "yes":
            self.set_info("ScaledBorderAndShadow", "yes")

        info = self._style_lines()
        if info:
            _, fields, styles = info
            for idx, data in styles:
                for field in SCALABLE_STYLE_FIELDS:
                    raw = data.get(field, "")
                    if raw in ("", None):
                        continue
                    try:
                        val = float(raw)
                    except ValueError:
                        continue
                    scaled = int(round(val * ratio))
                    if field == "Fontsize":
                        scaled = max(4, scaled)
                    data[field] = str(max(0, scaled))
                self.lines[idx] = "Style: " + ",".join(data.get(f, "") for f in fields)
        return True

    # -- convenience -------------------------------------------------------
    def cue_count(self) -> int:
        return len(self.dialogues())
