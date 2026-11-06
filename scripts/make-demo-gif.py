#!/usr/bin/env python3
"""Render a demo transcript as the animated terminal GIF shown at the top of the README.

    uv run --with pillow python scripts/make-demo-gif.py \
        --input docs/assets/demo-transcript.json --output docs/assets/demo.gif

Input: a JSON array of {"speaker": "system"|"buyer"|"seller"|"tool"|"human"|"result", "text": str}.
Output: a looping 1100x620 GIF of at most --max-mb megabytes, typed out line by line.
Needs only Pillow. The DejaVu Sans Mono font is downloaded once from its official GitHub release
(checksum-pinned) into a cache directory; JetBrains Mono is not used because it has no glyph for ₹.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import textwrap
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_ZIP_URL = (
    "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip"
)
FONT_ZIP_SHA256 = "7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a"
FONT_MEMBERS = {
    "regular": "dejavu-fonts-ttf-2.37/ttf/DejaVuSansMono.ttf",
    "bold": "dejavu-fonts-ttf-2.37/ttf/DejaVuSansMono-Bold.ttf",
}

W, H = 1100, 620
TITLE_H, PAD_X, PAD_Y = 40, 24, 16
BG, TITLE_BG, TITLE_FG = (13, 17, 23), (22, 27, 34), (139, 148, 158)
DOTS = [(255, 95, 86), (255, 189, 46), (39, 201, 63)]
TITLE = "pnpm demo — AgentBazaar"
END_HOLD_MS = 4000


@dataclass(frozen=True)
class Style:
    color: tuple[int, int, int]
    label: str
    chars_per_frame: int
    frame_ms: int
    pause_ms: int


STYLES = {
    "system": Style((139, 148, 158), "", 8, 30, 350),
    "buyer": Style((121, 192, 255), "buyer  │ ", 3, 40, 500),
    "seller": Style((255, 166, 87), "seller │ ", 3, 40, 1000),
    "tool": Style((57, 197, 207), "tool   │ ", 8, 30, 250),
    "human": Style((210, 168, 255), "human  │ ", 3, 40, 900),
    "result": Style((63, 185, 80), "✓ ", 4, 40, 0),
}


def cache_dir() -> Path:
    return Path(os.environ.get("AGENTBAZAAR_CACHE") or Path.home() / ".cache" / "agentbazaar") / "fonts"


def font_paths(directory: Path) -> dict[str, Path]:
    """Returns the cached font files, downloading and verifying the release archive if needed."""
    paths = {key: directory / Path(member).name for key, member in FONT_MEMBERS.items()}
    if all(p.is_file() for p in paths.values()):
        return paths
    directory.mkdir(parents=True, exist_ok=True)
    print(f"Downloading DejaVu Sans Mono into {directory}")
    with urllib.request.urlopen(FONT_ZIP_URL, timeout=120) as response:  # noqa: S310 (fixed https URL)
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != FONT_ZIP_SHA256:
        sys.exit(f"Font archive checksum mismatch ({digest}); refusing to use it.")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for key, member in FONT_MEMBERS.items():
            tmp = paths[key].with_suffix(".part")
            tmp.write_bytes(archive.read(member))  # fixed member names, so no path traversal
            os.replace(tmp, paths[key])
    return paths


def load_fonts(size: int, directory: Path | None = None) -> dict[str, ImageFont.FreeTypeFont]:
    paths = font_paths(directory or cache_dir())
    return {key: ImageFont.truetype(str(path), size) for key, path in paths.items()}


def missing_glyphs(font: ImageFont.FreeTypeFont, text: str) -> list[str]:
    """Characters the font would draw as a missing-glyph box (compared with an unassigned code point)."""
    def signature(ch: str) -> tuple[tuple[int, int], bytes]:
        mask = font.getmask(ch)
        return mask.size, bytes(mask)

    tofu = signature("\U0010fffd")
    return sorted({ch for ch in text if not ch.isspace() and signature(ch) == tofu})


def require_glyphs(fonts: dict[str, ImageFont.FreeTypeFont], text: str) -> None:
    missing = sorted({ch for font in fonts.values() for ch in missing_glyphs(font, text)})
    if missing:
        sys.exit("The font cannot draw: " + ", ".join(f"U+{ord(c):04X}" for c in missing))


def load_transcript(path: Path) -> list[dict[str, str]]:
    """Validates the transcript, which comes from a demo run, before anything is drawn."""
    entries = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not entries:
        sys.exit(f"{path}: expected a non-empty JSON array")
    for i, e in enumerate(entries):
        ok = isinstance(e, dict) and e.get("speaker") in STYLES and isinstance(e.get("text"), str)
        if not ok or not e["text"].strip() or len(e["text"]) > 2000:
            sys.exit(f"{path}: entry {i} needs a speaker in {sorted(STYLES)} and 1-2000 characters of text")
    return entries


def fit_font_size(cols: int, directory: Path | None) -> int:
    """Largest size at which `cols` characters fit across the window."""
    size = 40
    while size > 8 and load_fonts(size, directory)["regular"].getlength("M" * cols) > W - 2 * PAD_X:
        size -= 1
    return size


def build_palette() -> Image.Image:
    """One fixed palette with anti-aliasing shades, so every frame shares colours and only diffs are stored."""
    colours = [s.color for s in STYLES.values()] + [TITLE_FG, *DOTS]
    entries: list[tuple[int, int, int]] = []
    for bg in (BG, TITLE_BG):
        entries.append(bg)
        for c in colours:
            entries += [tuple(round(b + (f - b) * i / 8) for b, f in zip(bg, c, strict=True)) for i in range(1, 9)]
    entries = list(dict.fromkeys(entries))[:256]
    flat = [v for e in entries for v in e]
    palette = Image.new("P", (1, 1))
    palette.putpalette(flat + list(BG) * (256 - len(entries)))
    return palette


def wrap(entry: dict[str, str], cols: int) -> list[tuple[str, str]]:
    label = STYLES[entry["speaker"]].label
    lines: list[str] = []
    for paragraph in entry["text"].split("\n"):
        lines += textwrap.wrap(paragraph, cols - len(label), break_on_hyphens=False) or [""]
    return [(label if i == 0 else " " * len(label), line) for i, line in enumerate(lines)]


def render(cols: int, speed: int, entries: list[dict[str, str]], font_dir: Path | None) -> tuple[list[Image.Image], list[int]]:
    fonts = load_fonts(fit_font_size(cols, font_dir), font_dir)
    require_glyphs(fonts, TITLE + "".join(STYLES[e["speaker"]].label + e["text"] for e in entries))
    cell = fonts["regular"].getlength("M")
    line_h = int(fonts["regular"].size * 1.45)
    visible_rows = (H - TITLE_H - 2 * PAD_Y) // line_h
    palette = build_palette()

    base = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(base)
    draw.rectangle([0, 0, W, TITLE_H], fill=TITLE_BG)
    for i, dot in enumerate(DOTS):
        draw.ellipse([18 + i * 22, 14, 30 + i * 22, 26], fill=dot)
    draw.text((W / 2, TITLE_H / 2), TITLE, font=fonts["regular"], fill=TITLE_FG, anchor="mm")

    done: list[tuple[str, str, tuple[int, int, int]]] = []
    frames: list[Image.Image] = []
    durations: list[int] = []

    def snap(row: tuple[str, str, tuple[int, int, int]], ms: int) -> None:
        img = base.copy()
        d = ImageDraw.Draw(img)
        rows = (done + [row])[-visible_rows:]
        for n, (prefix, text, colour) in enumerate(rows):
            y = TITLE_H + PAD_Y + n * line_h
            if prefix.strip():
                d.text((PAD_X, y), prefix, font=fonts["bold"], fill=colour)
            if text:
                d.text((PAD_X + len(prefix) * cell, y), text, font=fonts["regular"], fill=colour)
        cursor_x = PAD_X + (len(row[0]) + len(row[1])) * cell
        cursor_y = TITLE_H + PAD_Y + (len(rows) - 1) * line_h
        d.rectangle([cursor_x, cursor_y + 2, cursor_x + cell * 0.6, cursor_y + line_h - 6], fill=row[2])
        frames.append(img.quantize(palette=palette, dither=Image.Dither.NONE))
        durations.append(ms)

    for entry in entries:
        style = STYLES[entry["speaker"]]
        step = style.chars_per_frame * speed
        for prefix, text in wrap(entry, cols):
            for n in range(step, len(text) + step, step):
                snap((prefix, text[:n], style.color), style.frame_ms)
            done.append((prefix, text, style.color))
        durations[-1] += style.pause_ms
    durations[-1] += END_HOLD_MS
    return frames, durations


def main() -> None:
    sys.stdout.reconfigure(errors="backslashreplace")  # Windows consoles cannot print every path
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", type=Path, default=Path("docs/assets/demo-transcript.json"))
    parser.add_argument("--output", type=Path, default=Path("docs/assets/demo.gif"))
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--max-mb", type=float, default=6.0)
    parser.add_argument("--font-dir", type=Path, help="Use fonts already in this directory (offline runs)")
    args = parser.parse_args()

    entries = load_transcript(args.input)
    limit = int(args.max_mb * 1_000_000)
    for speed in (1, 2, 3, 5):  # type faster until the file fits the size budget
        frames, durations = render(args.cols, speed, entries, args.font_dir)
        buffer = io.BytesIO()
        frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=1)
        if buffer.tell() <= limit:
            break
    else:
        sys.exit(f"Could not fit the GIF in {args.max_mb} MB; shorten the transcript.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(buffer.getvalue())
    with Image.open(args.output) as gif:  # self-check what we wrote
        assert gif.size == (W, H) and gif.n_frames > 1 and gif.info.get("loop") == 0
        frames_written = gif.n_frames
    size_mb = args.output.stat().st_size / 1_000_000
    assert size_mb <= args.max_mb
    print(f"Wrote {args.output}: {frames_written} frames, {sum(durations) / 1000:.1f} s, {size_mb:.2f} MB (typing speed x{speed})")


if __name__ == "__main__":
    main()
