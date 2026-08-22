/**
 * The language's own name for itself, derived from the tag rather than a table
 * that would have to be kept in step with the locale directory.
 *
 * Intl returns these lowercase in several languages ("français", "português"),
 * which is right mid-sentence but reads as a typo in a standalone list, so the
 * first letter is uppercased in the language's own casing rules.
 */
export function nativeLanguageName(tag: string): string {
  try {
    // 'standard' composes regional variants as "language (Region)" —
    // "Português (Portugal)" — where the default 'dialect' mode picks
    // ICU-version-dependent dialect names like "Português europeu",
    // breaking the parenthetical pattern next to "Português (Brasil)".
    const name = new Intl.DisplayNames([tag], { type: 'language', languageDisplay: 'standard' }).of(tag)
    // Intl echoes the input back when it has no name for the tag.
    if (!name || name === tag) return tag
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1)
  } catch {
    return tag
  }
}
