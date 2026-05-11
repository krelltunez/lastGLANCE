"""lastGLANCE asset generator — single source of truth.

Run from /home/claude/lastglance/. Outputs land in ./build/.
"""
import os
import math

# ─────────────────────────────────────────────────────────
# BRAND CONSTANTS
# ─────────────────────────────────────────────────────────
BG = '#05081A'           # near-black, slight blue
CARD = '#1D2538'         # card background
DIM = '#1D2538'          # dim dot color (same as card)
BRIGHT = '#3DDC84'       # primary green
MID = '#21B658'          # mid green
DEEP = '#15803D'         # deep green
WHITE = '#EEF1F8'        # off-white
SUBTLE = '#5A6478'       # subtle gray

# Matrix grid configuration
COLS = 12
ROWS = 12
DOT_RATIO = 0.58         # dot fills 58% of cell
ROUNDING = 0.18          # subtle dot corner rounding

# ─────────────────────────────────────────────────────────
# CORE MATRIX SVG GENERATOR
# ─────────────────────────────────────────────────────────

def matrix_svg(bright_cells, mid_cells=None, deep_cells=None,
               size=512, rx_ratio=0.18, transparent_bg=False,
               include_xmlns=True, margin_ratio=0.0625):
    """Generate the dot-matrix square SVG.

    Args:
        bright_cells: list of (col, row) tuples for bright dots
        mid_cells: list of (col, row) for mid-green dots
        deep_cells: list of (col, row) for deep-green dots
        size: pixel dimension of the output square
        rx_ratio: corner rounding ratio for the outer container (0.18 = ~18%)
        transparent_bg: if True, omit the background rect (for maskable variants)
        margin_ratio: margin around the matrix as ratio of size
    """
    mid_cells = mid_cells or []
    deep_cells = deep_cells or []

    margin = size * margin_ratio
    inner = size - margin * 2
    cell = inner / COLS
    dot = cell * DOT_RATIO
    dot_radius = dot * ROUNDING
    container_rx = size * rx_ratio

    xmlns = ' xmlns="http://www.w3.org/2000/svg"' if include_xmlns else ''
    parts = [f'<svg{xmlns} width="{size}" height="{size}" viewBox="0 0 {size} {size}">']

    if not transparent_bg:
        parts.append(f'  <rect width="{size}" height="{size}" rx="{container_rx:.2f}" fill="{BG}"/>')

    bright_set = set(bright_cells)
    mid_set = set(mid_cells)
    deep_set = set(deep_cells)

    for r in range(ROWS):
        for c in range(COLS):
            cx = margin + c * cell + cell / 2
            cy = margin + r * cell + cell / 2
            if (c, r) in bright_set:
                fill = BRIGHT
            elif (c, r) in mid_set:
                fill = MID
            elif (c, r) in deep_set:
                fill = DEEP
            else:
                fill = DIM
            x = cx - dot / 2
            y = cy - dot / 2
            parts.append(
                f'  <rect x="{x:.2f}" y="{y:.2f}" width="{dot:.2f}" height="{dot:.2f}" '
                f'rx="{dot_radius:.2f}" fill="{fill}"/>'
            )

    parts.append('</svg>')
    return '\n'.join(parts)


# ─────────────────────────────────────────────────────────
# CELL DEFINITIONS for J5 (primary) and J3 (favicon)
# ─────────────────────────────────────────────────────────

# J5: Gradient lowercase "l", no foot
# Two-cell-wide vertical bar with 3-tier gradient: deep → mid → bright (top → bottom)
J5_BRIGHT = [(5, 7), (5, 8), (5, 9), (6, 7), (6, 8), (6, 9)]
J5_MID = [(5, 5), (5, 6), (6, 5), (6, 6)]
J5_DEEP = [(5, 3), (5, 4), (6, 3), (6, 4)]

# J3: Uniform bright lowercase "l", no foot
J3_BRIGHT = [
    (5, 3), (5, 4), (5, 5), (5, 6), (5, 7), (5, 8), (5, 9),
    (6, 3), (6, 4), (6, 5), (6, 6), (6, 7), (6, 8), (6, 9),
]


# ─────────────────────────────────────────────────────────
# ICON GENERATION
# ─────────────────────────────────────────────────────────

def write_svg(path, content):
    with open(path, 'w') as f:
        f.write(content)
    print(f"  wrote {path}")


def generate_icons():
    """Generate the primary J5 icon and J3 favicon icon at multiple sizes."""
    print("Generating J5 (primary) source SVGs...")
    # Primary source SVG (clean, 512px)
    j5_512 = matrix_svg(J5_BRIGHT, J5_MID, J5_DEEP, size=512, rx_ratio=0.18)
    write_svg('build/source-svg/icon-primary.svg', j5_512)

    # Square (no rounded corners) for use inside other containers
    j5_512_square = matrix_svg(J5_BRIGHT, J5_MID, J5_DEEP, size=512, rx_ratio=0)
    write_svg('build/source-svg/icon-primary-square.svg', j5_512_square)

    # Maskable variant — needs safe zone (Android masks crop ~10% off each side)
    # For maskable, we expand the margin and shrink the matrix to fit in inner ~80% safe zone
    j5_maskable = matrix_svg(J5_BRIGHT, J5_MID, J5_DEEP,
                             size=512, rx_ratio=0,
                             margin_ratio=0.18)  # ~18% margin = matrix in safe zone
    write_svg('build/source-svg/icon-maskable.svg', j5_maskable)

    print("Generating J3 (favicon) source SVG...")
    j3_512 = matrix_svg(J3_BRIGHT, size=512, rx_ratio=0.18)
    write_svg('build/source-svg/icon-favicon-source.svg', j3_512)


# ─────────────────────────────────────────────────────────
# WORDMARK LOCKUP
# ─────────────────────────────────────────────────────────

def generate_wordmark():
    """Generate the lastGLANCE wordmark lockup as SVG.

    The wordmark uses 'last' in white (sans-serif bold) and 'GLANCE'
    in italic bright green. We use system-safe font stacks; for the
    final web-deployed wordmark, replace with web font.
    """
    print("Generating wordmark lockup SVGs...")

    # Standalone wordmark (no icon)
    # Use web-safe font stack with fallback. The original screenshot uses
    # what appears to be a bold geometric sans-serif. We'll specify a stack
    # that works cross-platform.
    font_stack = ('-apple-system, BlinkMacSystemFont, "Segoe UI", '
                  'Roboto, "Helvetica Neue", Arial, sans-serif')

    # Wordmark only — text-based SVG
    # ViewBox sized to fit "lastGLANCE" at 120px font with comfortable padding
    # "last" is ~240px wide, "GLANCE" italic is ~520px wide, plus padding
    wordmark_only = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 200" width="980" height="200">
  <rect width="980" height="200" fill="{BG}"/>
  <text x="50" y="148"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        letter-spacing="-3"
        fill="{WHITE}">last</text>
  <text x="288" y="148"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        font-style="italic"
        letter-spacing="-2"
        fill="{BRIGHT}">GLANCE</text>
</svg>'''
    write_svg('build/wordmark/wordmark.svg', wordmark_only)

    # Wordmark on transparent background
    wordmark_transparent = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 200" width="980" height="200">
  <text x="50" y="148"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        letter-spacing="-3"
        fill="{WHITE}">last</text>
  <text x="288" y="148"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        font-style="italic"
        letter-spacing="-2"
        fill="{BRIGHT}">GLANCE</text>
</svg>'''
    write_svg('build/wordmark/wordmark-transparent.svg', wordmark_transparent)

    # Lockup: icon + wordmark side by side
    # Icon at 144px sits next to 144px-cap-height type
    icon_inline = matrix_svg(J5_BRIGHT, J5_MID, J5_DEEP, size=144, rx_ratio=0.18,
                             include_xmlns=False)
    # Strip the outer <svg> tag and reuse content
    icon_inner = icon_inline.replace(
        '<svg width="144" height="144" viewBox="0 0 144 144">', ''
    ).replace('</svg>', '').strip()

    lockup = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 220" width="1180" height="220">
  <rect width="1180" height="220" fill="{BG}"/>
  <g transform="translate(40, 38)">
    <svg width="144" height="144" viewBox="0 0 144 144">
      {icon_inner}
    </svg>
  </g>
  <text x="220" y="160"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        letter-spacing="-3"
        fill="{WHITE}">last</text>
  <text x="458" y="160"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        font-style="italic"
        letter-spacing="-2"
        fill="{BRIGHT}">GLANCE</text>
</svg>'''
    write_svg('build/wordmark/lockup-horizontal.svg', lockup)

    # Lockup transparent (no background)
    lockup_transparent = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 220" width="1180" height="220">
  <g transform="translate(40, 38)">
    <svg width="144" height="144" viewBox="0 0 144 144">
      {icon_inner}
    </svg>
  </g>
  <text x="220" y="160"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        letter-spacing="-3"
        fill="{WHITE}">last</text>
  <text x="458" y="160"
        font-family='{font_stack}'
        font-size="120"
        font-weight="800"
        font-style="italic"
        letter-spacing="-2"
        fill="{BRIGHT}">GLANCE</text>
</svg>'''
    write_svg('build/wordmark/lockup-horizontal-transparent.svg', lockup_transparent)


# ─────────────────────────────────────────────────────────
# OG IMAGE (1200×630)
# ─────────────────────────────────────────────────────────

def generate_og():
    """Generate Open Graph / social card image at 1200×630.

    Layout: icon top-left, wordmark right of icon, tagline below,
    decorative dot-matrix ribbon along bottom showing the "header" pattern.
    """
    print("Generating OG image SVG...")

    font_stack = ('-apple-system, BlinkMacSystemFont, "Segoe UI", '
                  'Roboto, "Helvetica Neue", Arial, sans-serif')

    # Build a decorative wide ribbon matrix similar to the screenshot header
    # 60 columns × 8 rows, with sparse green dots at the right edge
    RIBBON_COLS = 50
    RIBBON_ROWS = 7

    def ribbon(x_offset, y_offset, width, height, bright_cells, mid_cells, deep_cells):
        margin_x = 0
        margin_y = 0
        cell_w = width / RIBBON_COLS
        cell_h = height / RIBBON_ROWS
        cell = min(cell_w, cell_h)
        dot = cell * DOT_RATIO
        dot_radius = dot * ROUNDING
        bright_set = set(bright_cells)
        mid_set = set(mid_cells)
        deep_set = set(deep_cells)
        parts = []
        for r in range(RIBBON_ROWS):
            for c in range(RIBBON_COLS):
                cx = x_offset + c * cell + cell / 2
                cy = y_offset + r * cell + cell / 2
                if (c, r) in bright_set:
                    fill = BRIGHT
                elif (c, r) in mid_set:
                    fill = MID
                elif (c, r) in deep_set:
                    fill = DEEP
                else:
                    fill = DIM
                x = cx - dot / 2
                y = cy - dot / 2
                parts.append(
                    f'<rect x="{x:.2f}" y="{y:.2f}" width="{dot:.2f}" height="{dot:.2f}" '
                    f'rx="{dot_radius:.2f}" fill="{fill}"/>'
                )
        return '\n  '.join(parts)

    # Sparse cluster of activity at the right end of the ribbon
    # Mirrors the actual app header pattern
    ribbon_bright = [(48, 1), (48, 4), (49, 2), (49, 5), (47, 3)]
    ribbon_mid = [(45, 2), (46, 4), (44, 1)]
    ribbon_deep = [(40, 5), (42, 3), (38, 1)]

    ribbon_svg = ribbon(60, 470, 1080, 100, ribbon_bright, ribbon_mid, ribbon_deep)

    # Inline the J5 icon at 200px
    icon_inline = matrix_svg(J5_BRIGHT, J5_MID, J5_DEEP, size=200, rx_ratio=0.18,
                             include_xmlns=False)
    icon_inner = icon_inline.replace(
        '<svg width="200" height="200" viewBox="0 0 200 200">', ''
    ).replace('</svg>', '').strip()

    og_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <!-- Background -->
  <rect width="1200" height="630" fill="{BG}"/>

  <!-- Subtle vignette gradient -->
  <defs>
    <radialGradient id="vignette" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#0A1024" stop-opacity="1"/>
      <stop offset="100%" stop-color="{BG}" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#vignette)"/>

  <!-- Icon -->
  <g transform="translate(80, 100)">
    <svg width="200" height="200" viewBox="0 0 200 200">
      {icon_inner}
    </svg>
  </g>

  <!-- Wordmark -->
  <text x="320" y="200"
        font-family='{font_stack}'
        font-size="110"
        font-weight="800"
        letter-spacing="-3"
        fill="{WHITE}">last</text>
  <text x="540" y="200"
        font-family='{font_stack}'
        font-size="110"
        font-weight="800"
        font-style="italic"
        letter-spacing="-2"
        fill="{BRIGHT}">GLANCE</text>

  <!-- Tagline -->
  <text x="320" y="270"
        font-family='{font_stack}'
        font-size="32"
        font-weight="400"
        letter-spacing="-0.5"
        fill="{WHITE}"
        opacity="0.85">When did you last...?</text>

  <!-- Body line -->
  <text x="80" y="380"
        font-family='{font_stack}'
        font-size="26"
        font-weight="400"
        fill="{WHITE}"
        opacity="0.6">A last-done tracker for the things that matter.</text>
  <text x="80" y="418"
        font-family='{font_stack}'
        font-size="26"
        font-weight="400"
        fill="{WHITE}"
        opacity="0.6">No deadlines. No nagging. Just information.</text>

  <!-- Decorative ribbon at bottom -->
  {ribbon_svg}

  <!-- Subtle bottom rule -->
  <line x1="60" y1="450" x2="1140" y2="450" stroke="{CARD}" stroke-width="1"/>
</svg>'''

    write_svg('build/og/og-image.svg', og_svg)


# ─────────────────────────────────────────────────────────
# RUN
# ─────────────────────────────────────────────────────────

if __name__ == '__main__':
    generate_icons()
    generate_wordmark()
    generate_og()
    print("\nSVG generation complete.")
