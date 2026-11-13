import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { iconMarkup, type IconTable } from './icons';
import { canonicalName, iconGroups } from '../../scripts/lucide-names.mjs';

const TABLE: IconTable = { icons: { Sprout: '<path d="s"/>' }, aliases: { LucideSprout: 'Sprout', SproutIcon: 'Sprout' } };

describe('chore icons', () => {
  it('draw by any name the app stores, and by no other', () => {
    expect(iconMarkup(TABLE, 'Sprout')).toBe('<path d="s"/>');
    expect(iconMarkup(TABLE, 'LucideSprout')).toBe('<path d="s"/>');
    expect(iconMarkup(TABLE, 'SproutIcon')).toBe('<path d="s"/>');
    for (const name of [null, undefined, '', 'Nope', 'constructor', '__proto__', 'toString']) expect(iconMarkup(TABLE, name), String(name)).toBeNull();
  });

  it('every icon the keys and the plugin images use is one the app\'s Lucide has', () => {
    const names = new Set(iconGroups().flatMap(([, n]: [unknown, string[]]) => n));
    expect(names.size).toBeGreaterThan(1000);
    const used = [
      ...readFileSync(new URL('./keys.ts', import.meta.url), 'utf-8').matchAll(/icon: '([A-Za-z]+)'/g),
      ...readFileSync(new URL('../scripts/gen-assets.mjs', import.meta.url), 'utf-8').matchAll(/\['([A-Za-z]+)', '#/g),
    ].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const name of used) expect(names.has(name), name).toBe(true);
    expect(canonicalName(['LucideSprout', 'Sprout'])).toBe('Sprout');
  });
});
