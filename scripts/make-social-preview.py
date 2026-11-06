#!/usr/bin/env python3
"""Render the 1280x640 GitHub social preview image.

    uv run --with pillow python scripts/make-social-preview.py --output docs/assets/social-preview.png

Upload the result in the repository's Settings > General > Social preview. Uses the same cached,
checksum-verified DejaVu Sans Mono font as scripts/make-demo-gif.py.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 1280, 640
LEFT = 80
BG, CARD_BG, BORDER = (13, 17, 23), (22, 27, 34), (48, 54, 61)
WHITE, DIM, ACCENT = (230, 237, 243), (139, 148, 158), (63, 185, 80)
BUYER, SELLER = (121, 192, 255), (255, 166, 87)

# Numbers from the demo keyboard negotiation, asserted in apps/api/src/modules/pricing/domain/policy.spec.ts.
SNIPPET = [
    ("buyer  │ ", "Can you do ₹4,400?", BUYER),
    ("seller │ ", "I can do: ₹5,472 each. Take 3 and I can do ₹5,364 each.", SELLER),
    ("       │ ", "… two more rounds: ₹5,390, then ₹5,253 …", DIM),
    ("buyer  │ ", "Last offer: ₹5,100.", BUYER),
    ("seller │ ", "Deal! ₹5,100 each. Check out before 05:45 pm.", SELLER),
]


def demo_gif_module():
    """scripts/make-demo-gif.py has a hyphenated name, so it is loaded by path."""
    path = Path(__file__).with_name("make-demo-gif.py")
    spec = importlib.util.spec_from_file_location("make_demo_gif", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses looks the module up while it executes
    spec.loader.exec_module(module)
    return module


def main() -> None:
    sys.stdout.reconfigure(errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", type=Path, default=Path("docs/assets/social-preview.png"))
    parser.add_argument("--font-dir", type=Path, help="Use fonts already in this directory (offline runs)")
    args = parser.parse_args()

    gif = demo_gif_module()
    title, tagline, mono, badges, small = (gif.load_fonts(size, args.font_dir) for size in (96, 36, 24, 32, 20))
    texts = ["AgentBazaar", "The full store for the agent era.", "MCP · A2A · UPI · GST", "MIT licence · github.com/mukulkathuria/AgentBazaar"]
    gif.require_glyphs(mono, "".join(t for _, t, _ in SNIPPET) + "".join(texts) + "│")

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 8], fill=ACCENT)
    d.text((LEFT, 70), texts[0], font=title["bold"], fill=WHITE)
    d.text((LEFT, 182), texts[1], font=tagline["regular"], fill=DIM)

    cell, line_h, top = mono["regular"].getlength("M"), 38, 262
    d.rounded_rectangle([LEFT, top, W - LEFT, top + 40 + line_h * len(SNIPPET)], radius=14, fill=CARD_BG, outline=BORDER, width=2)
    for n, (label, text, colour) in enumerate(SNIPPET):
        y = top + 22 + n * line_h
        d.text((LEFT + 28, y), label, font=mono["bold"], fill=colour)
        d.text((LEFT + 28 + len(label) * cell, y), text, font=mono["regular"], fill=colour)

    d.text((LEFT, 548), texts[2], font=badges["bold"], fill=ACCENT)
    d.text((W - LEFT, 560), texts[3], font=small["regular"], fill=DIM, anchor="ra")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.output, optimize=True)
    with Image.open(args.output) as written:  # self-check: GitHub wants 1280x640 and under 1 MB
        assert written.size == (W, H)
    size_kb = args.output.stat().st_size / 1000
    assert size_kb < 1000
    print(f"Wrote {args.output}: {W}x{H}, {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
