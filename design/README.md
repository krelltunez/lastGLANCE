# lastGLANCE — Brand Asset Reference

## Color palette

```css
--bg:         #05081A;  /* near-black with slight blue undertone */
--card:       #1D2538;  /* card background, dim dot color */
--bright:     #3DDC84;  /* primary brand green */
--mid:        #21B658;  /* mid green (gradient step) */
--deep:       #15803D;  /* deep green (gradient step) */
--white:      #EEF1F8;  /* off-white for text */
--subtle:     #5A6478;  /* muted gray for secondary text */
```

## Icon concept

Lowercase "l" rendered in a 12×12 dot matrix. Two-cell-wide vertical bar with a vertical gradient: deep green at top, mid green in middle, bright green at the bottom. The gradient embodies the lastGLANCE thesis — elapsed time fading from the past (top, dim) toward the present (bottom, bright). Background is the brand near-black with subtly rounded outer corners (~18%).

Two icon variants ship:
- **J5 (gradient)** — used everywhere ≥ 72px (PWA icons, app icon, hero, social)
- **J3 (uniform bright)** — used only at favicon sizes (16/32/48). Uniform brightness preserves legibility at small sizes where the gradient becomes invisible

## Wordmark

`last` in white, sans-serif, weight 800, slightly tightened tracking.
`GLANCE` in italic, same weight and family, in primary brand green.
Match dayGLANCE / lifeGLANCE family pattern (lowercase prefix + uppercase italic GLANCE) but distinct typographic treatment from those siblings (geometric/utility sans rather than Lora serif).

The system font stack used in the SVGs is a portable fallback. For the production app, replace with the actual brand font (e.g. a self-hosted Inter, Manrope, or a more distinctive geometric sans) in CSS, and consider re-exporting the SVGs with that font path-converted for use as standalone assets.

## File inventory

```
build/
├── manifest.json                              # PWA manifest
├── head-snippet.html                          # <head> tag wiring
├── source-svg/
│   ├── icon-primary.svg                       # J5 with rounded corners (512px viewBox)
│   ├── icon-primary-square.svg                # J5 with no rounding (for masks)
│   ├── icon-favicon-source.svg                # J3 with rounded corners
│   └── icon-maskable.svg                      # J5 with safe-zone padding for adaptive icons
├── icons/
│   ├── icon-{72,96,128,144,152,192,384,512}.png   # PWA standard sizes
│   ├── icon-maskable-{192,512}.png            # Android adaptive
│   ├── apple-touch-icon.png                   # 180×180, iOS will mask
│   └── apple-touch-icon-180.png               # explicit-size duplicate
├── favicon/
│   ├── favicon-{16,32,48}.png                 # PNG favicons
│   └── favicon.ico                            # multi-resolution ICO
├── wordmark/
│   ├── wordmark.svg                           # wordmark on dark bg
│   ├── wordmark-transparent.svg               # transparent bg
│   ├── wordmark.png + @2x.png                 # raster fallbacks
│   ├── wordmark-transparent.png
│   ├── lockup-horizontal.svg                  # icon + wordmark
│   ├── lockup-horizontal-transparent.svg
│   ├── lockup-horizontal.png
│   └── lockup-horizontal-transparent.png
└── og/
    ├── og-image.svg                           # 1200×630 social card source
    └── og-image.png                           # 1200×630 PNG for og:image
```

## Usage notes

- The icon files in `icons/` have **rounded corners baked in** (matching iOS standard 18% radius). For platforms that mask their own (Android adaptive), use the `icon-maskable-*` files.
- The favicon variant (J3) is intentionally different from the PWA icon (J5) — favicons render at 16/32px where gradients vanish.
- The OG image bottom ribbon is a stylized version of the actual app header pattern. Keeping this consistency between the marketing image and the in-app header is intentional.
- The brand green `#3DDC84` is the green from the screenshot — match this color exactly anywhere brand consistency matters (hero text, links, accent).
- No em dashes anywhere. (Brand rule, observed.)

## Regenerating

`generate.py` is the single source of truth. All SVGs derive from it; PNG renders are produced via cairosvg from the SVGs. To change the icon shape, edit the `J5_*` / `J3_*` cell lists in `generate.py` and re-run.
