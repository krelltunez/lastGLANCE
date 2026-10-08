import { registerPlugin } from '@capacitor/core'
import type { i18n as I18n } from 'i18next'
import { resolveLanguage } from '@/locales'
import { isAndroid, isIOS } from './platform'

// Keeps the in-app language and Android's per-app language the same choice
// (issue #327, AppLocalePlugin.java). Android 13+ only; below that the plugin
// reports unsupported and everything here is a no-op.
//
// Direction matters. Only an explicit pick in the in-app picker is sent to
// Android: sending the language i18next detected at startup would pin every
// user's app to whatever their phone's language was that day, and stop it from
// following the system. In the other direction, a language set in Android
// Settings is adopted whenever Android reports one, because that is the user
// choosing it.
export interface AppLocalePlugin {
  get(): Promise<{ supported: boolean; tag?: string | null }>
  set(options: { tag: string | null }): Promise<void>
  addListener(event: 'changed', cb: (data: { tag?: string | null }) => void): Promise<{ remove: () => Promise<void> }>
}

const AppLocale = registerPlugin<AppLocalePlugin>('AppLocale')

/** Send an explicit in-app language choice to Android. */
export async function setNativeAppLanguage(lng: string, plugin: AppLocalePlugin = AppLocale): Promise<void> {
  if (!isAndroid()) return
  try {
    await plugin.set({ tag: lng })
  } catch {
    // Best effort: the web UI already switched, which is what the user sees.
  }
}

/**
 * Adopt Android's per-app language at startup and whenever it changes in
 * Settings. Resolved through the same function as the detector, so a tag
 * Android reports in another shape ("pt-PT", "zh-Hans-CN") lands on a language
 * that ships.
 */
export async function syncAppLanguageFromNative(i18n: I18n, plugin: AppLocalePlugin = AppLocale): Promise<void> {
  if (!isAndroid()) return
  const adopt = (tag?: string | null) => {
    if (!tag) return
    const lng = resolveLanguage(tag)
    if (lng !== resolveLanguage(i18n.resolvedLanguage || i18n.language)) void i18n.changeLanguage(lng)
  }
  try {
    const { supported, tag } = await plugin.get()
    if (!supported) return
    adopt(tag)
    await plugin.addListener('changed', ({ tag }) => adopt(tag))
  } catch {
    // An older native shell without the plugin: nothing to sync with.
  }
}

// iOS (issue: Settings > lastGLANCE > Language left the app UI behind).
//
// iOS keeps the app language itself: Settings > lastGLANCE > Language, or the
// phone's language when none is set. The widgets follow it directly, but the web
// UI reads i18next's cached choice before navigator.language, so after a change
// in Settings the screens stayed on the old language while the widgets switched.
//
// There is no API to ask iOS whether the user set a per-app language, so this
// watches for change instead: the language iOS hands the WebView is remembered,
// and when it differs at the next launch (Settings relaunches the app), the user
// changed it there, and the UI follows. The in-app picker still works on its own
// terms in between, and is the only way to choose a language when the phone has
// a single preferred language and iOS shows no Language row at all.
export const IOS_LANGUAGE_SEEN_KEY = 'lastglance.iosLanguageSeen'

export function followIOSLanguageChanges(
  i18n: I18n,
  reported: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): void {
  if (!isIOS() || !reported || !storage) return
  try {
    const seen = storage.getItem(IOS_LANGUAGE_SEEN_KEY)
    storage.setItem(IOS_LANGUAGE_SEEN_KEY, reported)
    // First launch with this code: nothing to compare against, and adopting
    // here would override every existing user's in-app choice.
    if (seen === null || seen === reported) return
    const lng = resolveLanguage(reported)
    if (lng !== resolveLanguage(i18n.resolvedLanguage || i18n.language)) void i18n.changeLanguage(lng)
  } catch {
    // Storage unavailable: keep the cached language, as before.
  }
}
