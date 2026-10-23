# Renders assets/cover.png: the voice bar's three Gaussian-beam states drawn as
# braille dots, using the same formulas as index.ts. Usage: cover.py <out.png>
import math, sys
from PIL import Image, ImageDraw, ImageFont

W, H, S = 1280, 640, 2  # draw at 2x, downsample for smooth dots
img = Image.new("RGB", (W * S, H * S), "#0d1117")
d = ImageDraw.Draw(img)
font = lambda path, size: ImageFont.truetype(path, size * S)
SANS, MONO = "/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/SFNSMono.ttf"

d.text((80 * S, 70 * S), "pi-voice", font=font(SANS, 64), fill="#e6edf3")
d.text((80 * S, 152 * S), "Talk to your coding agent. Full-duplex voice for Pi on macOS.", font=font(SANS, 28), fill="#9da7b3")

COLUMNS, ROWS = 72, 12          # braille cells across, dot rows (3 cells high)
DOT, PITCH_X, PITCH_Y = 3.4, 12.4, 6.6
LEFT = 80

def trace(cycles, phase, level):
    """Dot (column, row) pairs for one bar, joined vertically like index.ts."""
    dots, prev = set(), None
    for sample in range(COLUMNS * 2):
        x = sample / (COLUMNS * 2 - 1)
        c = x - 0.5
        a = 0.85 * level * math.exp(-0.5 * (c / 0.16) ** 2) * math.cos(c * math.pi * 2 * cycles - phase)
        y = max(0, min(11, round(5.5 - a * 5.4)))
        lo, hi = (y, y) if prev is None else (min(prev, y), max(prev, y))
        for row in range(lo, hi + 1):
            dots.add((sample, row))
        prev = y
    return dots

bars = [
    ("listening", "#58a6ff", trace(5.2, 0.6, 0.9), "low voice, ~110 Hz"),
    ("thinking", "#d29922", trace(8, 2.1, 1.0), "Pi is working"),
    ("speaking", "#3fb950", trace(13.5, 1.3, 0.95), "brighter tone, ~800 Hz"),
]
top = 222
for i, (name, color, dots, note) in enumerate(bars):
    y0 = top + i * 108
    d.text((LEFT * S, (y0 + 8) * S), name, font=font(MONO, 20), fill=color)
    d.text((LEFT * S, (y0 + 36) * S), note, font=font(SANS, 16), fill="#6e7681")
    x0 = LEFT + 240
    for sample, row in dots:
        cx = x0 + sample * PITCH_X / 2
        cy = y0 + row * PITCH_Y + (row // 4) * 2
        r = DOT / 2
        d.ellipse(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S), fill=color)

d.text((80 * S, 572 * S), "pi install npm:@lprsrts/pi-voice", font=font(MONO, 22), fill="#e6edf3")
img.resize((W, H), Image.LANCZOS).save(sys.argv[1], optimize=True)
