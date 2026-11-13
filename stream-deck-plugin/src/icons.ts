// Chore icons by the names the app stores them under. The table is generated
// from lucide-react, the package the app draws with (scripts/gen-assets.mjs,
// using the widgets' scripts/lucide-names.mjs), so every name a chore can hold
// (Sprout, LucideSprout, SproutIcon, an older alias) draws the same icon the
// app shows. Each icon is stored once, under its canonical name.

export interface IconTable {
  /** Canonical name to the icon's inner SVG markup (24x24, stroked). */
  icons: Record<string, string>;
  /** Every other name to its canonical name. */
  aliases: Record<string, string>;
}

/** The icon's markup for any name the app stores, or null for none or an unknown one. */
export function iconMarkup(table: IconTable, name: string | null | undefined): string | null {
  if (!name) return null;
  const own = Object.prototype.hasOwnProperty.call(table.icons, name) ? table.icons[name] : undefined;
  if (own !== undefined) return own;
  const canonical = Object.prototype.hasOwnProperty.call(table.aliases, name) ? table.aliases[name] : undefined;
  return canonical !== undefined ? table.icons[canonical] ?? null : null;
}
