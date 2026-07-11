"""Generate the Open Graph preview image for File SQL.

Run: python3 scripts/build-og-image.py
Output: site/assets/og-image.png (1200x630).

Design intent (matches site/styles.css):
  - dark navy background (#0d1117) with a faint graph-paper grid
  - subtle amber glow anchored top-centre
  - left column: eyebrow pill / two-line headline / three-line subhead
  - right column: a mini VS Code window showing a SQL query
  - footer band: brand mark + URL, DuckDB pill on the right
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# --- Palette (kept in lockstep with site/styles.css) -----------------------
BG          = (13, 17, 23)
SURFACE     = (22, 27, 34)
SURFACE_2   = (28, 33, 41)
BORDER      = (48, 54, 61)
TEXT        = (230, 237, 243)
MUTED       = (125, 133, 144)
MUTED_2     = (153, 161, 172)
ACCENT      = (255, 180, 84)
DUCKDB      = (255, 240, 0)
KEYWORD     = ACCENT
STRING      = (165, 229, 161)
NUM         = (121, 192, 255)
FN          = (210, 168, 255)
COMMENT     = (110, 118, 129)
INK         = BG

W, H = 1200, 630
FONTS = Path("/tmp/fs-fonts")

def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)

mono_bold = lambda s: font("JetBrainsMono-Bold.ttf", s)
mono_reg  = lambda s: font("JetBrainsMono-Regular.ttf", s)

def text_size(d, s, f):
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0], b[3] - b[1]

# ---------------------------------------------------------------------------
# 1. Base background — navy + faint grid + a properly-shaped amber glow
# ---------------------------------------------------------------------------
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img, "RGBA")

grid = 40
for x in range(0, W, grid):
    d.line([(x, 0), (x, H)], fill=(230, 237, 243, 10))
for y in range(0, H, grid):
    d.line([(0, y), (W, y)], fill=(230, 237, 243, 10))

# Amber glow — per-pixel radial in a top strip, capped low so it just tints
glow_h = 360
glow = Image.new("RGBA", (W, glow_h), (0, 0, 0, 0))
gp = glow.load()
cx, cy = W // 2, -40
max_r = 620
for y in range(glow_h):
    for x in range(W):
        dx, dy = x - cx, y - cy
        r2 = dx * dx + dy * dy
        if r2 > max_r * max_r:
            continue
        t = 1.0 - (math.sqrt(r2) / max_r)
        a = int(34 * (t * t))
        if a > 0:
            gp[x, y] = (255, 180, 84, a)
img.paste(glow, (0, 0), glow)
d = ImageDraw.Draw(img, "RGBA")

# ---------------------------------------------------------------------------
# 2. Left column — eyebrow, headline, subhead
# ---------------------------------------------------------------------------
pad = 72
y = 118

# Eyebrow pill
eb_text = "VS CODE EXTENSION"
eb_font = mono_reg(20)
eb_w, eb_h = text_size(d, eb_text, eb_font)
px_pad, py_pad = 18, 10
d.rounded_rectangle(
    (pad, y, pad + eb_w + px_pad * 2, y + eb_h + py_pad * 2 + 6),
    radius=999,
    fill=(255, 180, 84, 30),
    outline=(255, 180, 84, 90),
    width=1,
)
d.text((pad + px_pad, y + py_pad - 2), eb_text, font=eb_font, fill=ACCENT)
y += eb_h + py_pad * 2 + 28

# Headline — two lines, second in amber. Sized to fit inside the left column
# (target width ~ pad .. mock_x0 - 40 = ~588px at head_size 48).
head_size = 48
h_font = mono_bold(head_size)
line1 = "SQL for your files."
line2 = "Inside VS Code."
_, l1_h = text_size(d, line1, h_font)
d.text((pad, y), line1, font=h_font, fill=TEXT)
y += l1_h + 14
d.text((pad, y), line2, font=h_font, fill=ACCENT)
y += l1_h + 30

# Subhead
sub_font = mono_reg(20)
sub_lines = [
    "Right-click a CSV, JSON, Parquet,",
    "or S3 file — get a SQL table.",
    "100% local · powered by DuckDB.",
]
for line in sub_lines:
    d.text((pad, y), line, font=sub_font, fill=MUTED_2)
    y += 28

# ---------------------------------------------------------------------------
# 3. Right column — mini VS Code window mockup
# ---------------------------------------------------------------------------
mock_x0, mock_y0 = 700, 118
mock_x1, mock_y1 = W - pad, 448
r = 14

# Drop shadow
for i, alpha in enumerate([10, 18, 26]):
    off = (i + 1) * 8
    d.rounded_rectangle(
        (mock_x0 + off, mock_y0 + off, mock_x1 + off, mock_y1 + off),
        radius=r, fill=(0, 0, 0, alpha))

# Card
d.rounded_rectangle((mock_x0, mock_y0, mock_x1, mock_y1),
                    radius=r, fill=SURFACE, outline=BORDER, width=1)

# Title bar
tb_h = 36
d.rounded_rectangle((mock_x0, mock_y0, mock_x1, mock_y0 + tb_h),
                    radius=r, fill=(16, 21, 29))
d.rectangle((mock_x0, mock_y0 + tb_h - r, mock_x1, mock_y0 + tb_h),
            fill=(16, 21, 29))
d.line((mock_x0, mock_y0 + tb_h, mock_x1, mock_y0 + tb_h), fill=BORDER)

# Traffic lights
for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
    tx = mock_x0 + 20 + i * 20
    d.ellipse((tx - 6, mock_y0 + tb_h // 2 - 6,
               tx + 6, mock_y0 + tb_h // 2 + 6), fill=color)

d.text((mock_x0 + 100, mock_y0 + 9),
       "File SQL — sales.parquet", font=mono_reg(15), fill=MUTED)

# Tab strip
tab_y0 = mock_y0 + tb_h
tab_h = 34
d.rectangle((mock_x0, tab_y0, mock_x1, tab_y0 + tab_h), fill=(14, 19, 26))
d.line((mock_x0, tab_y0 + tab_h, mock_x1, tab_y0 + tab_h), fill=BORDER)
tab_w = 200
d.rectangle((mock_x0, tab_y0, mock_x0 + tab_w, tab_y0 + tab_h), fill=SURFACE)
d.rectangle((mock_x0, tab_y0, mock_x0 + tab_w, tab_y0 + 2), fill=ACCENT)
d.line((mock_x0 + tab_w, tab_y0, mock_x0 + tab_w, tab_y0 + tab_h), fill=BORDER)
d.text((mock_x0 + 18, tab_y0 + 8), "sales.parquet",
       font=mono_reg(15), fill=TEXT)
d.text((mock_x0 + tab_w - 22, tab_y0 + 6), "×",
       font=mono_reg(18), fill=MUTED)

# Editor body — code font sized so the widest line fits inside the card
ed_y0 = tab_y0 + tab_h + 18
ln_font = mono_reg(13)
code_font = mono_reg(15)
gutter_x = mock_x0 + 22
code_x = mock_x0 + 58
line_h = 26

sql_lines = [
    [("-- Top regions by revenue, 2026", COMMENT)],
    [("SELECT", KEYWORD), (" region, ", TEXT), ("SUM", FN),
     ("(revenue) ", TEXT), ("AS", KEYWORD), (" total", TEXT)],
    [("FROM", KEYWORD), (" ", TEXT), ("'sales.parquet'", STRING)],
    [("WHERE", KEYWORD), (" year = ", TEXT), ("2026", NUM)],
    [("GROUP BY", KEYWORD), (" region", TEXT)],
    [("ORDER BY", KEYWORD), (" total ", TEXT), ("DESC", KEYWORD), (";", TEXT)],
]

for i, segments in enumerate(sql_lines):
    ly = ed_y0 + i * line_h
    d.text((gutter_x, ly + 2), str(i + 1),
           font=ln_font, fill=(74, 83, 97))
    cx = code_x
    for text, color in segments:
        d.text((cx, ly), text, font=code_font, fill=color)
        w, _ = text_size(d, text, code_font)
        cx += w

# ---------------------------------------------------------------------------
# 4. Footer band
# ---------------------------------------------------------------------------
foot_top = H - 100
d.line((pad, foot_top, W - pad, foot_top), fill=BORDER)

mark_x = pad
mark_y = foot_top + 22
d.rounded_rectangle((mark_x, mark_y, mark_x + 44, mark_y + 52),
                    radius=6, fill=SURFACE_2, outline=BORDER, width=1)
d.polygon([(mark_x + 36, mark_y), (mark_x + 44, mark_y),
           (mark_x + 44, mark_y + 8)], fill=ACCENT)
d.rounded_rectangle((mark_x + 6, mark_y + 32, mark_x + 38, mark_y + 46),
                    radius=3, fill=DUCKDB)
d.text((mark_x + 10, mark_y + 33), "SQL",
       font=mono_bold(11), fill=INK)

d.text((mark_x + 58, mark_y + 4), "File SQL",
       font=mono_bold(26), fill=TEXT)
d.text((mark_x + 58, mark_y + 34),
       "arunkumar1997.github.io/vscode-sql-files",
       font=mono_reg(15), fill=MUTED)

# DuckDB pill on the right
pill_txt = "Powered by DuckDB"
pill_font = mono_bold(16)
pw, ph = text_size(d, pill_txt, pill_font)
ppx, ppy = 20, 12
pill_x1 = W - pad
pill_x0 = pill_x1 - pw - ppx * 2 - 20
pill_y0 = mark_y + 12
pill_y1 = pill_y0 + ph + ppy * 2 + 2
d.rounded_rectangle((pill_x0, pill_y0, pill_x1, pill_y1),
                    radius=999,
                    fill=(255, 240, 0, 24),
                    outline=(255, 240, 0, 100), width=1)
dot_r = 5
mid = (pill_y0 + pill_y1) // 2
d.ellipse((pill_x0 + 14, mid - dot_r,
           pill_x0 + 14 + dot_r * 2, mid + dot_r), fill=DUCKDB)
d.text((pill_x0 + 14 + dot_r * 2 + 8, pill_y0 + ppy - 2),
       pill_txt, font=pill_font, fill=DUCKDB)

# ---------------------------------------------------------------------------
# 5. Save
# ---------------------------------------------------------------------------
out = Path("site/assets/og-image.png")
img.save(out, "PNG", optimize=True)
print(f"Wrote {out} — {out.stat().st_size:,} bytes ({W}x{H})")
