import { describe, expect, it } from 'vitest';
import { escapeXml, renderKey, renderStrip } from './render';

const svgOf = (url: string) => {
  expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
  return Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf-8');
};
const ICON = '<path d="M7 20h10"/>';

describe('drawing a key', () => {
  it('draws the icon in the accent, the name, the line under it, and the bar', () => {
    const svg = svgOf(renderKey({ title: 'Water plants', sub: '3d', icon: 'Sprout', accent: '#ef4444', ratio: 0.5 }, ICON));
    expect(svg).toContain('width="144" height="144"');
    expect(svg).toContain('stroke="#ef4444"');
    expect(svg).toContain(ICON);
    expect(svg).toContain('>Water plants<');
    expect(svg).toContain('>3d<');
    expect(svg).toContain('width="60"');        // half of the 120-wide bar
  });

  it('clamps the bar, and draws none without a ratio', () => {
    expect(svgOf(renderKey({ title: 'x', accent: '#f00', ratio: 2.4 }, null))).toContain('width="120" height="6" rx="3" fill="#f00"');
    expect(svgOf(renderKey({ title: 'x', accent: '#f00', ratio: null }, null))).not.toContain('fill="#2a2e38"');
  });

  it('draws a count large, and greys a dim key', () => {
    expect(svgOf(renderKey({ title: '7', accent: '#ef4444', big: true }, null))).toContain('font-size="64"');
    expect(svgOf(renderKey({ title: 'x', accent: '#64748b', dim: true }, ICON))).toContain('stroke-opacity="0.45"');
  });

  it('escapes names, so a chore called <b> & co stays text', () => {
    const svg = svgOf(renderKey({ title: 'Tom & <Jo>', accent: '#fff' }, null));
    expect(svg).toContain('Tom &amp; &lt;Jo&gt;');
    expect(escapeXml(`"'`)).toBe('&quot;&apos;');
  });

  it('draws the touch strip at its size', () => {
    const svg = svgOf(renderStrip({ title: 'Dust', sub: '1/2 · 2d', accent: '#f59e0b', ratio: 0.8 }, ICON));
    expect(svg).toContain('width="200" height="100"');
    expect(svg).toContain('>Dust<');
  });
});
