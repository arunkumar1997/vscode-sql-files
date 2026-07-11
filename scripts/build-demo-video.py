"""Generate site/assets/demo.mp4 — the landing-page 60-second walkthrough.

Same approach as scripts/build-og-image.py:
  1. Render every frame with Pillow into /tmp/fs-frames/
  2. Encode with ffmpeg into H.264 MP4 (yuv420p — plays everywhere)
  3. Save the first frame as demo-poster.png for slow connections

Three chapters (chapter cards + animated scene each):
  1. Install once        ~10s  (VS Code Extensions Marketplace UI)
  2. Right-click a file  ~12s  (auto-registers as a table, no dialog)
  3. Query with SQL      ~22s
Total: ~44s at 60 fps => 2640 frames.

Fonts: JetBrains Mono only (matches OG image; keeps the script self-
contained). Pillow is a dev-only tool — not added to the extension's
package.json.
"""

from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
W, H = 1200, 676  # 16:9-ish; H is even so libx264 accepts it as-is
FPS = 60
FONTS = Path("/tmp/fs-fonts")

FRAMES_DIR = Path("/tmp/fs-frames")
OUT_MP4 = Path("site/assets/demo.mp4")
OUT_POSTER = Path("site/assets/demo-poster.png")

# Palette (matches site/styles.css)
BG = (13, 17, 23)
SURFACE = (22, 27, 34)
SURFACE_2 = (28, 33, 41)
BORDER = (48, 54, 61)
TEXT = (230, 237, 243)
MUTED = (125, 133, 144)
MUTED_2 = (153, 161, 172)
ACCENT = (255, 180, 84)
DUCKDB = (255, 240, 0)
GREEN = (54, 150, 85)
BLUE_SEL = (9, 71, 113)
RED_LIGHT = (255, 95, 86)
YEL_LIGHT = (255, 189, 46)
GRN_LIGHT = (39, 201, 63)
KEYWORD = ACCENT
STRING = (165, 229, 161)
NUM = (121, 192, 255)
FN = (210, 168, 255)
COMMENT = (110, 118, 129)
INK = BG
VSCODE_BG = (30, 30, 30)
VSCODE_SB = (24, 28, 34)
VSCODE_HDR = (37, 37, 38)
CTX_BG = (37, 37, 38)
CTX_BORDER = (69, 69, 69)


# ---------------------------------------------------------------------------
# Font helpers
# ---------------------------------------------------------------------------
def _f(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def mono(size: int) -> ImageFont.FreeTypeFont:
    return _f("JetBrainsMono-Regular.ttf", size)


def mono_bold(size: int) -> ImageFont.FreeTypeFont:
    return _f("JetBrainsMono-Bold.ttf", size)


def tw(d: ImageDraw.ImageDraw, s: str, f) -> tuple[int, int]:
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0], b[3] - b[1]


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------
def new_frame() -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img, "RGBA")
    # Faint graph paper
    for x in range(0, W, 40):
        d.line([(x, 0), (x, H)], fill=(230, 237, 243, 10))
    for y in range(0, H, 40):
        d.line([(0, y), (W, y)], fill=(230, 237, 243, 10))
    return img


def draw_chapter_ribbon(d: ImageDraw.ImageDraw, num: int, title: str) -> None:
    """Amber pill top-left with '01' / '02' / '03' and the chapter title."""
    pill_f = mono_bold(20)
    num_txt = f"0{num}"
    tit_f = mono_bold(24)

    num_w, num_h = tw(d, num_txt, pill_f)
    tit_w, tit_h = tw(d, title, tit_f)

    x0 = 56
    y0 = 44
    # Number pill
    px_pad = 14
    d.rounded_rectangle(
        (x0, y0, x0 + num_w + px_pad * 2, y0 + num_h + 14),
        radius=999,
        fill=(255, 180, 84, 45),
        outline=(255, 180, 84, 130),
        width=1,
    )
    d.text((x0 + px_pad, y0 + 4), num_txt, font=pill_f, fill=ACCENT)

    # Title next to it
    d.text((x0 + num_w + px_pad * 2 + 14, y0 + 8), title, font=tit_f, fill=TEXT)


def draw_footer(d: ImageDraw.ImageDraw) -> None:
    """Persistent File SQL wordmark + DuckDB pill at the bottom."""
    y = H - 46
    d.line((56, y - 10, W - 56, y - 10), fill=BORDER)

    # Brand mark (miniature)
    mx, my = 56, y - 4
    d.rounded_rectangle(
        (mx, my, mx + 26, my + 30), radius=4, fill=SURFACE_2, outline=BORDER, width=1
    )
    d.polygon([(mx + 20, my), (mx + 26, my), (mx + 26, my + 6)], fill=ACCENT)
    d.rounded_rectangle((mx + 4, my + 20, mx + 22, my + 27), radius=2, fill=DUCKDB)
    d.text((mx + 6, my + 19), "SQL", font=mono_bold(7), fill=INK)

    d.text((mx + 36, my + 5), "File SQL", font=mono_bold(16), fill=TEXT)

    # DuckDB pill on the right
    txt = "Powered by DuckDB"
    f = mono_bold(12)
    tw_w, tw_h = tw(d, txt, f)
    ppx, ppy = 12, 6
    x1 = W - 56
    x0 = x1 - tw_w - ppx * 2 - 14
    y0 = my + 4
    y1 = y0 + tw_h + ppy * 2 - 2
    d.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=999,
        fill=(255, 240, 0, 22),
        outline=(255, 240, 0, 90),
        width=1,
    )
    dot_r = 3
    mid = (y0 + y1) // 2
    d.ellipse((x0 + 10, mid - dot_r, x0 + 10 + dot_r * 2, mid + dot_r), fill=DUCKDB)
    d.text((x0 + 10 + dot_r * 2 + 6, y0 + ppy - 3), txt, font=f, fill=DUCKDB)


def draw_window(
    d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], title: str, bg=SURFACE
) -> None:
    """Draw a VS-Code-like window frame."""
    x0, y0, x1, y1 = box
    # Drop shadow
    for i, a in enumerate([10, 18, 26]):
        off = (i + 1) * 6
        d.rounded_rectangle(
            (x0 + off, y0 + off, x1 + off, y1 + off), radius=12, fill=(0, 0, 0, a)
        )
    # Card
    d.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=bg, outline=BORDER, width=1)
    # Titlebar
    tb_h = 30
    d.rounded_rectangle((x0, y0, x1, y0 + tb_h), radius=12, fill=(16, 21, 29))
    d.rectangle((x0, y0 + tb_h - 12, x1, y0 + tb_h), fill=(16, 21, 29))
    d.line((x0, y0 + tb_h, x1, y0 + tb_h), fill=BORDER)
    # Traffic lights
    for i, color in enumerate([RED_LIGHT, YEL_LIGHT, GRN_LIGHT]):
        cx = x0 + 18 + i * 18
        d.ellipse((cx - 5, y0 + tb_h // 2 - 5, cx + 5, y0 + tb_h // 2 + 5), fill=color)
    # Title
    d.text((x0 + 90, y0 + 8), title, font=mono(13), fill=MUTED)


def draw_cursor(d: ImageDraw.ImageDraw, x: int, y: int) -> None:
    """Simple arrow cursor pointing NW at (x,y)."""
    # White filled polygon with dark outline
    poly = [
        (x, y),
        (x + 14, y + 12),
        (x + 6, y + 12),
        (x + 10, y + 20),
        (x + 6, y + 22),
        (x + 2, y + 14),
        (x, y + 16),
    ]
    d.polygon(poly, fill=(255, 255, 255), outline=(0, 0, 0))


# ---------------------------------------------------------------------------
# Scene 1 — Install from the VS Code Extensions Marketplace
# ---------------------------------------------------------------------------
def scene_install(t: float) -> Image.Image:
    """Scene 1 timeline (~10s):
    0.0 - 1.2 s  cursor glides to the Extensions icon in the activity bar
    1.2 s        click; Extensions panel is visible
    1.5 - 2.2 s  cursor moves to the search input
    2.2 - 4.6 s  types 'File SQL' char-by-char
    4.6 - 5.0 s  result card fades in
    5.0 - 6.2 s  cursor moves to the Install button
    6.4 s        click ripple on Install
    6.6 - 8.0 s  button shows 'Installing…' with spinner
    8.0 s        button flips to 'Uninstall' with a green check overlay
    """
    img = new_frame()
    d = ImageDraw.Draw(img, "RGBA")
    draw_chapter_ribbon(d, 1, "Install once")

    # VS Code window
    box = (80, 130, W - 80, H - 110)
    draw_window(d, box, "Visual Studio Code", bg=VSCODE_BG)

    x0, y0, x1, y1 = box
    inner_top = y0 + 30
    ab_w = 44
    sb_w = 360  # Extensions view is wider than Explorer

    # --- Activity bar with the Extensions icon in position 5 -----------
    d.rectangle((x0, inner_top, x0 + ab_w, y1), fill=(24, 28, 34))
    icon_gap = 32
    icon_cy0 = inner_top + 22
    for i in range(6):
        cy = icon_cy0 + i * icon_gap
        color = (255, 255, 255) if i == 4 else (150, 155, 162)
        if i == 4:
            # Extensions icon: three squares + one offset (VS Code style)
            for dx, dy in [(0, 0), (1, 0), (0, 1)]:
                d.rectangle(
                    (
                        x0 + 14 + dx * 8,
                        cy + dy * 8,
                        x0 + 14 + dx * 8 + 6,
                        cy + dy * 8 + 6,
                    ),
                    fill=color,
                )
            # Fourth square offset to bottom-right at an angle
            d.rectangle((x0 + 22, cy + 8, x0 + 30, cy + 16), fill=color)
        else:
            d.rectangle((x0 + 12, cy, x0 + 32, cy + 20), fill=color)
    # Active indicator on Extensions (once panel is open)
    if t >= 1.2:
        d.rectangle(
            (x0, icon_cy0 + 4 * icon_gap - 4, x0 + 2, icon_cy0 + 4 * icon_gap + 24),
            fill=ACCENT,
        )

    # --- Extensions sidebar (visible after the click) ------------------
    sb_x0 = x0 + ab_w
    sb_x1 = sb_x0 + sb_w
    if t >= 1.2:
        # Slide in over 0.3s
        slide = min(1.0, (t - 1.2) / 0.3)
        d.rectangle((sb_x0, inner_top, sb_x1, y1), fill=VSCODE_SB)

        # Panel header
        d.text(
            (sb_x0 + 14, inner_top + 8),
            "EXTENSIONS: MARKETPLACE",
            font=mono(10),
            fill=(138, 146, 154),
        )

        # Search input
        srch_y0 = inner_top + 30
        srch_y1 = srch_y0 + 30
        d.rectangle(
            (sb_x0 + 10, srch_y0, sb_x1 - 10, srch_y1),
            fill=(60, 60, 60),
            outline=(69, 69, 69),
            width=1,
        )
        # Focus ring after cursor arrives at search (t >= 2.0)
        if t >= 2.0:
            d.rectangle(
                (sb_x0 + 10, srch_y0, sb_x1 - 10, srch_y1),
                outline=(14, 99, 156),
                width=1,
            )

        # Typed text
        query_full = "File SQL"
        if t < 2.2:
            typed = ""
        elif t < 4.6:
            p = (t - 2.2) / (4.6 - 2.2)
            n = int(len(query_full) * min(1.0, p))
            typed = query_full[:n]
        else:
            typed = query_full

        if typed:
            d.text((sb_x0 + 20, srch_y0 + 8), typed, font=mono(13), fill=TEXT)
            if t < 4.6 and int(t * 4) % 2 == 0:
                tw_txt, _ = tw(d, typed, mono(13))
                cx = sb_x0 + 20 + tw_txt + 2
                d.rectangle((cx, srch_y0 + 8, cx + 1, srch_y0 + 24), fill=TEXT)
        else:
            d.text(
                (sb_x0 + 20, srch_y0 + 8),
                "Search Extensions in Marketplace",
                font=mono(13),
                fill=MUTED,
            )
            if t >= 2.0 and int(t * 4) % 2 == 0:
                d.rectangle(
                    (sb_x0 + 20, srch_y0 + 8, sb_x0 + 21, srch_y0 + 24), fill=TEXT
                )

        # --- Result card (fades in at t=4.6) ---------------------------
        if t >= 4.6:
            fade_p = min(1.0, (t - 4.6) / 0.4)
            fa = int(255 * _easeout(fade_p))

            card_x0 = sb_x0 + 10
            card_x1 = sb_x1 - 10
            card_y0 = srch_y1 + 14
            card_y1 = card_y0 + 108

            # Card background
            hover = t >= 5.5  # hovered when cursor is near / on the button
            card_fill = (37, 37, 38) if hover else (30, 33, 39)
            d.rounded_rectangle(
                (card_x0, card_y0, card_x1, card_y1),
                radius=4,
                fill=(*card_fill, fa),
                outline=(69, 69, 69, fa if hover else fa // 2),
                width=1,
            )

            # Extension icon (mini File SQL brand mark)
            icx0 = card_x0 + 12
            icy0 = card_y0 + 14
            icw = 46
            d.rounded_rectangle(
                (icx0, icy0, icx0 + icw, icy0 + icw),
                radius=8,
                fill=(*SURFACE_2, fa),
                outline=(*BORDER, fa),
                width=1,
            )
            # Amber corner fold
            d.polygon(
                [(icx0 + icw - 10, icy0), (icx0 + icw, icy0), (icx0 + icw, icy0 + 10)],
                fill=(*ACCENT, fa),
            )
            # Green code strokes
            for i, w_len in enumerate([22, 18, 14]):
                d.line(
                    (icx0 + 8, icy0 + 12 + i * 6, icx0 + 8 + w_len, icy0 + 12 + i * 6),
                    fill=(126, 231, 135, fa),
                    width=2,
                )
            # Yellow SQL pill
            pill_x0 = icx0 + 6
            pill_x1 = icx0 + icw - 6
            pill_y0 = icy0 + icw - 14
            pill_y1 = icy0 + icw - 4
            d.rounded_rectangle(
                (pill_x0, pill_y0, pill_x1, pill_y1), radius=3, fill=(*DUCKDB, fa)
            )
            sql_txt = "SQL"
            sql_font = mono_bold(9)
            sw, sh = tw(d, sql_txt, sql_font)
            d.text(
                (
                    pill_x0 + ((pill_x1 - pill_x0) - sw) // 2,
                    pill_y0 + ((pill_y1 - pill_y0) - sh) // 2 - 1,
                ),
                sql_txt,
                font=sql_font,
                fill=(*INK, fa),
            )

            # Name + version + publisher
            tx = icx0 + icw + 14
            d.text((tx, card_y0 + 12), "File SQL", font=mono_bold(14), fill=(*TEXT, fa))
            name_w, _ = tw(d, "File SQL", mono_bold(14))
            d.text(
                (tx + name_w + 8, card_y0 + 15),
                "v1.1.0",
                font=mono(10),
                fill=(*MUTED_2, fa),
            )
            d.text(
                (tx, card_y0 + 32), "arunkumar1997", font=mono(11), fill=(*MUTED_2, fa)
            )
            # Description
            d.text(
                (card_x0 + 12, card_y0 + 62),
                "Query CSV, JSON, Parquet, S3.",
                font=mono(11),
                fill=(*MUTED, fa),
            )
            # Stats
            d.text(
                (card_x0 + 12, card_y0 + 82),
                "12.4K installs   ·   MIT",
                font=mono(10),
                fill=(*MUTED, fa),
            )

            # --- Install button --------------------------------------
            btn_h = 26
            btn_pad_x = 14
            btn_label_font = mono_bold(11)
            if t < 6.6:
                btn_label = "Install"
                btn_fill = (14, 99, 156)  # VS Code button blue
                btn_border = None
            elif t < 8.0:
                btn_label = "Installing\u2026"
                btn_fill = (55, 55, 55)
                btn_border = (85, 85, 85)
            else:
                btn_label = "Uninstall"
                btn_fill = (55, 55, 55)
                btn_border = (85, 85, 85)

            btn_tw, _ = tw(d, btn_label, btn_label_font)
            # Pin width to the widest label ('Installing…') so the button
            # doesn't grow between states and cover the description below.
            widest_w, _ = tw(d, "Installing\u2026", btn_label_font)
            btn_w = widest_w + btn_pad_x * 2
            label_offset = (btn_w - (btn_tw + btn_pad_x * 2)) // 2 + btn_pad_x
            btn_x1 = card_x1 - 12
            btn_x0 = btn_x1 - btn_w
            btn_y1 = card_y1 - 12
            btn_y0 = btn_y1 - btn_h

            d.rounded_rectangle(
                (btn_x0, btn_y0, btn_x1, btn_y1),
                radius=3,
                fill=(*btn_fill, fa),
                outline=(*btn_border, fa) if btn_border else None,
                width=1 if btn_border else 0,
            )
            d.text(
                (btn_x0 + label_offset, btn_y0 + (btn_h - btn_label_font.size) // 2 + 1),
                btn_label,
                font=btn_label_font,
                fill=(255, 255, 255, fa),
            )

            # Spinner while installing
            if 6.6 <= t < 8.0:
                phase = int((t - 6.6) * 10) % 8
                spinner_chars = "|/-\\|/-\\"
                d.text(
                    (btn_x0 - 22, btn_y0 + 4),
                    spinner_chars[phase],
                    font=mono(14),
                    fill=ACCENT,
                )
            # Green checkmark after install
            if t >= 8.0:
                check_fade = min(1.0, (t - 8.0) / 0.3)
                cf = int(255 * check_fade)
                d.text(
                    (btn_x0 - 22, btn_y0 + 3),
                    "\u2713",
                    font=mono_bold(16),
                    fill=(126, 231, 135, cf),
                )

            # Click ripple on Install
            dt = t - 6.4
            if 0 <= dt < 0.6:
                rx = (btn_x0 + btn_x1) // 2
                ry = (btn_y0 + btn_y1) // 2
                r = int(30 * (dt / 0.6))
                a = int(160 * (1 - dt / 0.6))
                d.ellipse(
                    (rx - r, ry - r, rx + r, ry + r), outline=(*ACCENT, a), width=2
                )

    # --- Cursor path ----------------------------------------------------
    # Start: middle of the empty editor area.
    ext_icon_x = x0 + 22
    ext_icon_y = icon_cy0 + 4 * icon_gap + 8

    # Points of interest (only computed if sidebar visible)
    if t >= 1.2:
        srch_x = sb_x0 + 90
        srch_y = inner_top + 30 + 20
        install_btn_x = sb_x1 - 10 - 50
        install_btn_y = inner_top + 30 + 30 + 14 + 108 - 12 - 13
    else:
        srch_x, srch_y, install_btn_x, install_btn_y = 0, 0, 0, 0

    start_x, start_y = x0 + 700, inner_top + 260

    if t < 1.2:
        # Approach Extensions icon
        p = _easeout(min(1.0, t / 1.2))
        cx = int(start_x + (ext_icon_x - start_x) * p)
        cy = int(start_y + (ext_icon_y - start_y) * p)
    elif t < 1.5:
        cx, cy = ext_icon_x, ext_icon_y
    elif t < 2.2:
        p = _easeout(min(1.0, (t - 1.5) / 0.7))
        cx = int(ext_icon_x + (srch_x - ext_icon_x) * p)
        cy = int(ext_icon_y + (srch_y - ext_icon_y) * p)
    elif t < 5.2:
        cx, cy = srch_x, srch_y
    elif t < 6.2:
        p = _easeout(min(1.0, (t - 5.2) / 1.0))
        cx = int(srch_x + (install_btn_x - srch_x) * p)
        cy = int(srch_y + (install_btn_y - srch_y) * p)
    else:
        cx, cy = install_btn_x, install_btn_y

    if 0 <= cx < W and 0 <= cy < H:
        draw_cursor(d, cx, cy)

    # Click ripple on Extensions icon at t=1.2
    dt = t - 1.2
    if 0 <= dt < 0.4:
        r = int(22 * (dt / 0.4))
        a = int(160 * (1 - dt / 0.4))
        d.ellipse(
            (ext_icon_x - r, ext_icon_y - r, ext_icon_x + r, ext_icon_y + r),
            outline=(*ACCENT, a),
            width=2,
        )

    draw_footer(d)
    return img


# ---------------------------------------------------------------------------
# Scene 2 — Right-click any file → Open with File SQL
# ---------------------------------------------------------------------------
CTX_MENU = [
    ("Open Preview", "Ctrl+Shift+V"),
    ("Open with File SQL", None),  # highlighted
    ("Open to the Side", "Ctrl+Enter"),
    ("Open With...", None),
    ("Reveal in File Explorer", "Shift+Alt+R"),
    ("Open in Integrated Terminal", None),
    (None, None),  # separator
    ("Cut", "Ctrl+X"),
    ("Copy", "Ctrl+C"),
]


def _easeout(x: float) -> float:
    return 1 - (1 - x) ** 3


def scene_rightclick(t: float) -> Image.Image:
    """Scene 2 timeline (~12s):
     0.0 - 2.0 s  cursor glides in from the editor area and lands on the file
     2.0 - 2.6 s  file becomes selected (right-click)
     2.6 s        context menu fades in next to the file
     3.5 - 9.5 s  cursor walks a few menu items, settling on 'Open with File SQL'
    10.2 s        click ripple on 'Open with File SQL'
    10.5 - 12 s   menu vanishes and the cursor drifts away — the extension
                  silently registers the file and opens the query editor
                  (there is no confirmation notification). The crossfade
                  into Scene 3 shows the resulting query editor with the
                  customers table already loaded in the Tables sidebar.
    """
    img = new_frame()
    d = ImageDraw.Draw(img, "RGBA")
    draw_chapter_ribbon(d, 2, "Right-click any file")

    # VS Code window
    box = (80, 130, W - 80, H - 110)
    draw_window(d, box, "customers-1000000  —  Visual Studio Code", bg=VSCODE_BG)

    x0, y0, x1, y1 = box
    inner_top = y0 + 30
    ab_w = 44
    sb_w = 220

    # Activity bar
    d.rectangle((x0, inner_top, x0 + ab_w, y1), fill=(24, 28, 34))
    for i in range(6):
        cy = inner_top + 16 + i * 32
        d.rectangle(
            (x0 + 12, cy, x0 + 32, cy + 20),
            fill=(255, 255, 255) if i == 0 else (150, 155, 162),
            outline=None,
        )
    d.rectangle((x0, inner_top + 12, x0 + 2, inner_top + 12 + 22), fill=ACCENT)

    # Sidebar
    sb_x0 = x0 + ab_w
    sb_x1 = sb_x0 + sb_w
    d.rectangle((sb_x0, inner_top, sb_x1, y1), fill=VSCODE_SB)
    d.text((sb_x0 + 14, inner_top + 8), "EXPLORER", font=mono(10), fill=(138, 146, 154))
    d.text(
        (sb_x0 + 14, inner_top + 34),
        "\u25be  CUSTOMERS-1000000",
        font=mono(12),
        fill=(204, 204, 204),
    )
    file_y = inner_top + 58
    d.rounded_rectangle(
        (sb_x0 + 34, file_y + 2, sb_x0 + 46, file_y + 14), radius=2, fill=(78, 201, 176)
    )
    d.text(
        (sb_x0 + 52, file_y),
        "customers-1000000.csv",
        font=mono(12),
        fill=(204, 204, 204),
    )

    file_cursor_x = sb_x0 + 100
    file_cursor_y = file_y + 4

    # ---- Selected state after cursor arrives ----
    if t >= 2.0:
        d.rectangle(
            (sb_x0 + 32, file_y - 2, sb_x1 - 6, file_y + 18),
            fill=(255, 255, 255, 18),
            outline=(255, 255, 255, 35),
        )

    # ---- Context menu ----
    menu_shown_at = 2.6
    click_t = 10.2
    menu_gone_at = 10.5

    if menu_shown_at <= t < menu_gone_at:
        mx0 = sb_x1 + 10
        my0 = file_y + 8
        mw = 300
        line_h = 24
        rows = len(CTX_MENU)
        mh = 12 + line_h * rows + 4
        p = min(1.0, (t - menu_shown_at) / 0.3)
        alpha = int(255 * _easeout(p))

        menu = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
        md = ImageDraw.Draw(menu)
        md.rounded_rectangle(
            (0, 0, mw, mh),
            radius=4,
            fill=(*CTX_BG, alpha),
            outline=(*CTX_BORDER, alpha),
            width=1,
        )

        # Cursor hover schedule
        hover_idx = None
        if 3.5 <= t < 4.5:
            hover_idx = 0
        elif 4.5 <= t < 6.0:
            hover_idx = 1  # Open with File SQL
        elif 6.0 <= t < 7.0:
            hover_idx = 2
        elif 7.0 <= t < 8.0:
            hover_idx = 4
        elif 8.0 <= t < menu_gone_at:
            hover_idx = 1
        force_highlight_1 = t >= 4.5

        for i, (label, kbd) in enumerate(CTX_MENU):
            row_y = 8 + i * line_h
            if label is None:
                md.line(
                    (8, row_y + line_h // 2 - 4, mw - 8, row_y + line_h // 2 - 4),
                    fill=(58, 58, 58, alpha),
                )
                continue
            highlight = (i == hover_idx) or (i == 1 and force_highlight_1)
            if highlight:
                md.rounded_rectangle(
                    (4, row_y - 2, mw - 4, row_y + 20), radius=3, fill=(*ACCENT, alpha)
                )
                text_fill = (*INK, alpha)
                kbd_fill = (20, 24, 29, int(alpha * 0.7))
            else:
                text_fill = (204, 204, 204, alpha)
                kbd_fill = (138, 146, 154, alpha)
            md.text((14, row_y), label, font=mono(12), fill=text_fill)
            if kbd:
                kf = mono(11)
                kw = md.textbbox((0, 0), kbd, font=kf)[2]
                md.text((mw - 14 - kw, row_y + 1), kbd, font=kf, fill=kbd_fill)
        img.paste(menu, (mx0, my0), menu)

    # ---- No toast, no popup ----
    # Clicking 'Open with File SQL' auto-registers the file as a table and
    # opens the query editor directly — the extension does NOT surface a
    # confirmation notification. We simply let the menu vanish and the
    # crossfade to Scene 3 (which shows the resulting query editor with
    # the customers table already in the Tables sidebar) tells the story.

    # ---- Cursor ----
    start_x, start_y = x0 + 700, inner_top + 200
    if t < 2.0:
        p = _easeout(min(1.0, t / 2.0))
        cx = int(start_x + (file_cursor_x - start_x) * p)
        cy = int(start_y + (file_cursor_y - start_y) * p)
    elif t < menu_shown_at:
        cx, cy = file_cursor_x, file_cursor_y
    elif t < menu_gone_at:
        # Hover schedule maps to a row_y inside the menu
        idx_seq = [
            (3.5, 4.5, 0),
            (4.5, 6.0, 1),
            (6.0, 7.0, 2),
            (7.0, 8.0, 4),
            (8.0, menu_gone_at, 1),
        ]
        target = 1
        for s, e, idx in idx_seq:
            if s <= t < e:
                target = idx
                break
        mx0 = sb_x1 + 10
        my0 = file_y + 8
        row_h = 24
        cx = mx0 + 60
        cy = my0 + 8 + target * row_h + 6
    else:
        # After the click the cursor drifts back toward the editor area
        # so it doesn't sit on top of the toast.
        p = _easeout(min(1.0, (t - menu_gone_at) / 1.0))
        prev_x = sb_x1 + 10 + 60
        prev_y = file_y + 8 + 8 + 24 + 6
        end_x, end_y = x0 + 600, inner_top + 200
        cx = int(prev_x + (end_x - prev_x) * p)
        cy = int(prev_y + (end_y - prev_y) * p)

    if 0 <= cx < W and 0 <= cy < H:
        draw_cursor(d, cx, cy)

    # Click ripple on 'Open with File SQL'
    click_x = sb_x1 + 10 + 60
    click_y = file_y + 8 + 8 + 1 * 24 + 6
    dt = t - click_t
    if 0 <= dt < 0.6:
        r = int(30 * (dt / 0.6))
        a = int(160 * (1 - dt / 0.6))
        d.ellipse(
            (click_x - r, click_y - r, click_x + r, click_y + r),
            outline=(*ACCENT, a),
            width=2,
        )

    draw_footer(d)
    return img


# ---------------------------------------------------------------------------
# Scene 3 — Query with SQL
# ---------------------------------------------------------------------------
SQL_LINES = [
    [
        ("SELECT", KEYWORD),
        (" region, ", TEXT),
        ("SUM", FN),
        ("(revenue) ", TEXT),
        ("AS", KEYWORD),
        (" total", TEXT),
    ],
    [("FROM", KEYWORD), (" ", TEXT), ("'sales.parquet'", STRING)],
    [("WHERE", KEYWORD), (" year = ", TEXT), ("2026", NUM)],
    [("GROUP BY", KEYWORD), (" region", TEXT)],
    [("ORDER BY", KEYWORD), (" total ", TEXT), ("DESC", KEYWORD), (";", TEXT)],
]

RESULTS = [
    ("APAC", "$4,821,940"),
    ("EMEA", "$3,214,022"),
    ("Americas", "$2,987,113"),
    ("LATAM", "$1,102,584"),
]


def scene_query(t: float) -> Image.Image:
    img = new_frame()
    d = ImageDraw.Draw(img, "RGBA")
    draw_chapter_ribbon(d, 3, "Query with SQL")

    box = (60, 130, W - 60, H - 110)
    draw_window(d, box, "File SQL — Query Editor", bg=VSCODE_BG)

    x0, y0, x1, y1 = box
    inner_top = y0 + 30
    ab_w = 40
    sb_w = 220

    # Activity bar
    d.rectangle((x0, inner_top, x0 + ab_w, y1), fill=(24, 28, 34))
    for i in range(6):
        cy = inner_top + 14 + i * 30
        d.rectangle((x0 + 10, cy, x0 + 30, cy + 20), fill=(150, 155, 162))
    # File SQL is active — last icon
    d.rectangle(
        (x0 + 10, inner_top + 14 + 5 * 30, x0 + 30, inner_top + 14 + 5 * 30 + 20),
        fill=TEXT,
    )
    d.rectangle(
        (x0, inner_top + 14 + 5 * 30, x0 + 2, inner_top + 14 + 5 * 30 + 20), fill=ACCENT
    )

    # Tables sidebar
    sb_x0 = x0 + ab_w
    sb_x1 = sb_x0 + sb_w
    d.rectangle((sb_x0, inner_top, sb_x1, y1), fill=VSCODE_SB)
    d.text(
        (sb_x0 + 12, inner_top + 8),
        "File SQL: Tables",
        font=mono(11),
        fill=(204, 204, 204),
    )
    # Table header
    d.text((sb_x0 + 12, inner_top + 34), "\u25be", font=mono(10), fill=MUTED)
    d.rounded_rectangle(
        (sb_x0 + 30, inner_top + 36, sb_x0 + 42, inner_top + 48),
        radius=2,
        fill=(78, 201, 176),
    )
    d.text((sb_x0 + 48, inner_top + 34), "customers", font=mono_bold(12), fill=TEXT)
    d.text((sb_x0 + 130, inner_top + 36), "csv", font=mono(10), fill=MUTED)

    # Columns list — appear one by one over 0..2s
    cols = [
        ("Index", "BIGINT"),
        ("Customer Id", "VARCHAR"),
        ("First Name", "VARCHAR"),
        ("Last Name", "VARCHAR"),
        ("Company", "VARCHAR"),
        ("City", "VARCHAR"),
        ("Country", "VARCHAR"),
        ("Subscription Date", "DATE"),
    ]
    for i, (name, typ) in enumerate(cols):
        appear_at = 0.2 + i * 0.15
        if t < appear_at:
            break
        cy = inner_top + 58 + i * 20
        # Circle dot
        d.ellipse(
            (sb_x0 + 32, cy + 3, sb_x0 + 42, cy + 13), outline=(78, 201, 176), width=2
        )
        d.pieslice(
            (sb_x0 + 32, cy + 3, sb_x0 + 42, cy + 13),
            start=-90,
            end=90,
            fill=(78, 201, 176),
        )
        d.text((sb_x0 + 48, cy), name, font=mono(11), fill=(204, 204, 204))
        d.text((sb_x0 + 165, cy + 1), typ, font=mono(9), fill=MUTED)

    # ---- Editor area ----
    ed_x0 = sb_x1
    ed_x1 = x1
    ed_y0 = inner_top

    # Tab bar
    tab_h = 30
    d.rectangle((ed_x0, ed_y0, ed_x1, ed_y0 + tab_h), fill=(24, 28, 34))
    d.line((ed_x0, ed_y0 + tab_h, ed_x1, ed_y0 + tab_h), fill=BORDER)
    # Active tab
    d.rectangle((ed_x0, ed_y0, ed_x0 + 220, ed_y0 + tab_h), fill=VSCODE_BG)
    d.rectangle((ed_x0, ed_y0, ed_x0 + 220, ed_y0 + 2), fill=ACCENT)
    d.text((ed_x0 + 14, ed_y0 + 8), "File SQL — Query Editor", font=mono(11), fill=TEXT)
    d.text((ed_x0 + 200, ed_y0 + 7), "\u00d7", font=mono(14), fill=MUTED)

    # Toolbar
    tb_h = 28
    tb_y = ed_y0 + tab_h
    d.rectangle((ed_x0, tb_y, ed_x1, tb_y + tb_h), fill=(24, 28, 34))
    d.line((ed_x0, tb_y + tb_h, ed_x1, tb_y + tb_h), fill=BORDER)
    # Run button
    run_x0 = ed_x0 + 10
    run_y0 = tb_y + 4
    run_x1 = run_x0 + 62
    run_y1 = tb_y + tb_h - 4
    # Pulse the button around t=8-9 when we "click" run
    pulse = 1.0
    if 7.8 <= t < 8.6:
        pp = (t - 7.8) / 0.8
        pulse = 1 + 0.15 * math.sin(pp * math.pi)
    run_center = ((run_x0 + run_x1) // 2, (run_y0 + run_y1) // 2)
    rr_w = int((run_x1 - run_x0) * pulse)
    rr_h = int((run_y1 - run_y0) * pulse)
    d.rounded_rectangle(
        (
            run_center[0] - rr_w // 2,
            run_center[1] - rr_h // 2,
            run_center[0] + rr_w // 2,
            run_center[1] + rr_h // 2,
        ),
        radius=3,
        fill=GREEN,
    )
    d.polygon(
        [
            (run_x0 + 12, tb_y + 8),
            (run_x0 + 20, tb_y + tb_h // 2),
            (run_x0 + 12, tb_y + tb_h - 8),
        ],
        fill=(255, 255, 255),
    )
    d.text((run_x0 + 26, tb_y + 7), "Run", font=mono_bold(11), fill=(255, 255, 255))
    # Hint
    d.text(
        (ed_x0 + 88, tb_y + 7),
        "Ctrl+Enter · select text to run partial query",
        font=mono(11),
        fill=MUTED,
    )
    # Rows
    rows_text = ""
    if t >= 9.5:
        rows_text = "4 rows"
    if rows_text:
        rw, _ = tw(d, rows_text, mono(11))
        d.text((ed_x1 - 14 - rw, tb_y + 7), rows_text, font=mono(11), fill=MUTED_2)

    # SQL code area — starts after 2s
    code_y0 = tb_y + tb_h + 8
    # Type SQL out over 2..7.5s (5.5s duration)
    total_chars = sum(len(text) for line in SQL_LINES for text, _ in line)
    if t < 2.0:
        chars_visible = 0
    else:
        p = min(1.0, (t - 2.0) / 5.5)
        chars_visible = int(total_chars * p)

    # Render SQL with syntax colors up to chars_visible
    line_h = 24
    code_font = mono(16)
    consumed = 0
    for i, line in enumerate(SQL_LINES):
        ly = code_y0 + i * line_h
        d.text((ed_x0 + 22, ly + 2), str(i + 1), font=mono(11), fill=(74, 83, 97))
        cx = ed_x0 + 54
        for text, color in line:
            if consumed >= chars_visible:
                break
            remaining = chars_visible - consumed
            chunk = text[:remaining]
            d.text((cx, ly), chunk, font=code_font, fill=color)
            cw, _ = tw(d, chunk, code_font)
            cx += cw
            consumed += len(chunk)
        if consumed >= chars_visible:
            # caret
            if t < 8.0 and int(t * 2) % 2 == 0:
                d.rectangle((cx + 1, ly + 2, cx + 3, ly + 22), fill=TEXT)
            break

    # Results area — appears after 9.5s, rows fade in one at a time
    if t >= 9.5:
        res_y0 = code_y0 + 5 * line_h + 20
        # Header
        rw = ed_x1 - ed_x0
        d.rectangle((ed_x0, res_y0, ed_x1, res_y0 + 30), fill=(37, 37, 38))
        # Col widths
        # #: 50, region: 200, total: right-aligned
        d.text((ed_x0 + 14, res_y0 + 8), "#", font=mono_bold(12), fill=(204, 204, 204))
        d.text(
            (ed_x0 + 80, res_y0 + 8), "region", font=mono_bold(12), fill=(204, 204, 204)
        )
        d.text(
            (ed_x0 + 300, res_y0 + 8), "total", font=mono_bold(12), fill=(204, 204, 204)
        )
        d.line((ed_x0, res_y0 + 30, ed_x1, res_y0 + 30), fill=(43, 43, 43))
        # Rows
        for i, (region, total) in enumerate(RESULTS):
            appear = 10.0 + i * 0.3
            if t < appear:
                continue
            ry = res_y0 + 30 + i * 28
            # # column bg
            d.rectangle((ed_x0, ry, ed_x0 + 50, ry + 28), fill=(0, 0, 0, 40))
            d.text((ed_x0 + 14, ry + 6), str(i + 1), font=mono(12), fill=MUTED)
            d.text((ed_x0 + 80, ry + 6), region, font=mono(12), fill=TEXT)
            d.text((ed_x0 + 300, ry + 6), total, font=mono(12), fill=NUM)
            d.line((ed_x0, ry + 28, ed_x1, ry + 28), fill=(43, 43, 43))

    draw_footer(d)
    return img


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------
CH1_LEN = 10.0
CH2_LEN = 12.0  # right-click → auto-registers, no Quick Pick step
CH3_LEN = 22.0
TOTAL = CH1_LEN + CH2_LEN + CH3_LEN


def render_at(t: float) -> Image.Image:
    if t < CH1_LEN:
        return scene_install(t)
    if t < CH1_LEN + CH2_LEN:
        return scene_rightclick(t - CH1_LEN)
    return scene_query(t - CH1_LEN - CH2_LEN)


def crossfade(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
    return Image.blend(a, b, p)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    if FRAMES_DIR.exists():
        shutil.rmtree(FRAMES_DIR)
    FRAMES_DIR.mkdir(parents=True)

    total_frames = int(TOTAL * FPS)
    fade_frames = int(0.4 * FPS)  # short crossfade between chapters
    ch1_end = int(CH1_LEN * FPS)
    ch2_end = int((CH1_LEN + CH2_LEN) * FPS)

    print(f"Rendering {total_frames} frames " f"({TOTAL:.1f}s @ {FPS} fps)...")

    for f in range(total_frames):
        t = f / FPS

        # Chapter transitions
        if ch1_end - fade_frames <= f < ch1_end + fade_frames:
            # Fade between scene 1 tail and scene 2 head
            p = (f - (ch1_end - fade_frames)) / (fade_frames * 2)
            a = scene_install(CH1_LEN - 0.001)
            b = scene_rightclick(max(0.0, t - CH1_LEN))
            img = crossfade(a, b, p)
        elif ch2_end - fade_frames <= f < ch2_end + fade_frames:
            p = (f - (ch2_end - fade_frames)) / (fade_frames * 2)
            a = scene_rightclick(CH2_LEN - 0.001)
            b = scene_query(max(0.0, t - CH1_LEN - CH2_LEN))
            img = crossfade(a, b, p)
        else:
            img = render_at(t)

        img.save(FRAMES_DIR / f"f{f:05d}.png", "PNG")
        if f % 30 == 0:
            print(f"  frame {f}/{total_frames}")

    print("Encoding MP4 with ffmpeg...")
    OUT_MP4.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-framerate",
            str(FPS),
            "-i",
            str(FRAMES_DIR / "f%05d.png"),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "24",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(OUT_MP4),
        ],
        check=True,
    )

    # First frame as poster
    shutil.copy(FRAMES_DIR / "f00000.png", OUT_POSTER)
    print(f"Wrote {OUT_MP4} ({OUT_MP4.stat().st_size:,} B) " f"and {OUT_POSTER}")


if __name__ == "__main__":
    main()
