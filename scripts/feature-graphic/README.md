# Play Store feature graphic

Generates `public/brand/feature-graphic.png` — the 1024×500 Google Play
feature graphic: the lastGLANCE brand icon + the `last`/italic-green `GLANCE`
wordmark (in **Inter**, the app's `sans` brand font) on the brand-dark
background.

`feature-graphic.html` is the source. It references the brand icon at
`../../public/brand/icon-primary.svg` and three Inter font files that are **not
committed** (fetched on demand, see below).

## Regenerate

From the repo root:

```sh
# 1. Fetch the Inter web fonts (not vendored) into this folder.
cd scripts/feature-graphic
npm pack @fontsource/inter >/dev/null
tar xzf fontsource-inter-*.tgz
cp package/files/inter-latin-500-normal.woff2 inter-500.woff2
cp package/files/inter-latin-800-normal.woff2 inter-800.woff2
cp package/files/inter-latin-800-italic.woff2 inter-800i.woff2
rm -rf package fontsource-inter-*.tgz

# 2. Render to PNG at exactly 1024x500 with headless Chromium.
#    (Any Chromium/Chrome works; example uses Playwright's bundled binary.)
chromium --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --run-all-compositor-stages-before-draw --virtual-time-budget=4000 \
  --window-size=1024,500 --screenshot=../../public/brand/feature-graphic.png \
  "file://$PWD/feature-graphic.html"
```

The output is a 24-bit RGB PNG (no alpha) — Play Console's required format.

## Notes

- **Font:** Inter, SIL Open Font License 1.1 (https://github.com/rsms/inter).
  Fetched via the `@fontsource/inter` npm package; the `.woff2` files are
  intentionally git-ignored so the font binary isn't vendored here.
- Edit copy/layout/colors in `feature-graphic.html`, then re-run step 2.
- Brand colors: bg `#05081A`, "last" `#EEF1F8`, "GLANCE" `#3DDC84`.
