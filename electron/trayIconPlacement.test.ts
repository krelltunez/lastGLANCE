// Where the tray mark sits in its image (scripts/gen-desktop-icons.mjs). The
// macOS template is 1pt below centre, to line up with dayGLANCE's mark beside
// it in the menu bar; 1pt is all the 22pt image allows, so the frame's bottom
// edge meets the image's. The colour tray (Windows, Linux) stays centred.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.join(__dirname, 'resources', 'tray');

/** Rows [first, end) and columns [first, end) holding any opaque-ish pixel. */
async function inkBox(name: string) {
  const { data, info } = await sharp(path.join(dir, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let top = info.height, bottom = 0, left = info.width, right = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > 0) {
        top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
        left = Math.min(left, x); right = Math.max(right, x + 1);
      }
    }
  }
  return { size: info.width, top, bottom, left, right };
}

describe('the tray mark placement', () => {
  it.each([['trayTemplate.png', 1], ['trayTemplate@2x.png', 2]])('%s: 20pt, 1pt below centre, flush with the bottom', async (name, scale) => {
    expect(await inkBox(name)).toEqual({ size: 22 * scale, top: 2 * scale, bottom: 22 * scale, left: scale, right: 21 * scale });
  });

  it.each([['tray.png', 1], ['tray@2x.png', 2]])('%s: 20pt, centred', async (name, scale) => {
    expect(await inkBox(name)).toEqual({ size: 22 * scale, top: scale, bottom: 21 * scale, left: scale, right: 21 * scale });
  });
});
