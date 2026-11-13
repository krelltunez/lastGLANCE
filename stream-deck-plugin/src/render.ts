// Draws a key (keys.ts KeyView) as an SVG data URL, 144x144 for a key and
// 200x100 for a Stream Deck + touch strip: the chore's own icon in its cadence
// colour, its name, a short line under it, and the fill bar along the bottom,
// the same bar the app draws. Pure: the icon's markup is passed in
// (icons.ts), so this is tested without the icon table.

import type { KeyView } from './keys';
import { fit } from './keys';

const FONT = "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const BG = '#14161c';
const TRACK = '#2a2e38';

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
}

const dataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** A Lucide icon (24x24, stroked) placed at x,y in a box of `size`. */
function iconAt(markup: string, x: number, y: number, size: number, color: string, opacity: number): string {
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${markup}</g>`;
}

function bar(x: number, y: number, w: number, h: number, ratio: number | null | undefined, color: string): string {
  if (ratio === null || ratio === undefined) return '';
  const filled = Math.max(0, Math.min(1, ratio)) * w;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${TRACK}"/>`
    + (filled > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(filled, h)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '');
}

/** A 144x144 key. */
export function renderKey(view: KeyView, iconMarkup: string | null): string {
  const op = view.dim ? 0.45 : 1;
  const accent = view.accent;
  let body: string;
  if (view.big) {
    body = `<text x="72" y="84" font-family="${FONT}" font-size="64" font-weight="700" fill="${accent}" fill-opacity="${op}" text-anchor="middle">${escapeXml(fit(view.title, 4))}</text>`;
  } else {
    body = (iconMarkup ? iconAt(iconMarkup, 44, 18, 56, accent, op) : '')
      + `<text x="72" y="98" font-family="${FONT}" font-size="19" font-weight="700" fill="#ffffff" fill-opacity="${op}" text-anchor="middle">${escapeXml(fit(view.title, 12))}</text>`;
  }
  const sub = view.sub
    ? `<text x="72" y="${view.big ? 112 : 120}" font-family="${FONT}" font-size="16" fill="#ffffff" fill-opacity="${0.6 * op}" text-anchor="middle">${escapeXml(fit(view.sub, 16))}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`
    + `<rect width="144" height="144" fill="${BG}"/>`
    + body + sub
    + bar(12, 130, 120, 6, view.ratio, accent)
    + `</svg>`;
  return dataUrl(svg);
}

/** A 200x100 touch-strip panel (Stream Deck +): icon on the left, text on the right, the bar below. */
export function renderStrip(view: KeyView, iconMarkup: string | null): string {
  const op = view.dim ? 0.45 : 1;
  const textX = iconMarkup && !view.big ? 64 : 12;
  const icon = iconMarkup && !view.big ? iconAt(iconMarkup, 10, 22, 44, view.accent, op) : '';
  const title = view.big
    ? `<text x="12" y="62" font-family="${FONT}" font-size="44" font-weight="700" fill="${view.accent}" fill-opacity="${op}">${escapeXml(fit(view.title, 5))}</text>`
    : `<text x="${textX}" y="44" font-family="${FONT}" font-size="20" font-weight="700" fill="#ffffff" fill-opacity="${op}">${escapeXml(fit(view.title, 11))}</text>`;
  const sub = view.sub
    ? `<text x="${view.big ? 100 : textX}" y="${view.big ? 60 : 70}" font-family="${FONT}" font-size="15" fill="#ffffff" fill-opacity="${0.6 * op}">${escapeXml(fit(view.sub, view.big ? 12 : 14))}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">`
    + `<rect width="200" height="100" fill="${BG}"/>`
    + icon + title + sub
    + bar(12, 86, 176, 6, view.ratio, view.accent)
    + `</svg>`;
  return dataUrl(svg);
}
