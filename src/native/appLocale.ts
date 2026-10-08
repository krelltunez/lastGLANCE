import { registerPlugin } from '@capacitor/core'
import type { i18n as I18n } from 'i18next'
import { resolveLanguage } from '@/locales'
import { isAndroid } from './platform'

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
