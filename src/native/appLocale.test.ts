import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}) }))
const platform = vi.hoisted(() => ({ android: true, ios: false }))
vi.mock('./platform', () => ({ isAndroid: () => platform.android, isIOS: () => platform.ios }))

import type { i18n as I18n } from 'i18next'
import {
  IOS_LANGUAGE_SEEN_KEY,
  followIOSLanguageChanges,
  setNativeAppLanguage,
  syncAppLanguageFromNative,
  type AppLocalePlugin,
} from './appLocale'

function fakeI18n(language: string) {
  const i18n = {
    language,
    resolvedLanguage: language,
    changeLanguage: vi.fn(async (lng: string) => {
      i18n.language = lng
      i18n.resolvedLanguage = lng
    }),
  }
  return i18n
}

function fakePlugin(state: { supported: boolean; tag?: string | null }) {
  let listener: ((d: { tag?: string | null }) => void) | undefined
  const plugin = {
    get: vi.fn(async () => state),
    set: vi.fn(async () => {}),
    addListener: vi.fn(async (_e: 'changed', cb: (d: { tag?: string | null }) => void) => {
      listener = cb
      return { remove: async () => {} }
    }),
  }
  return { plugin: plugin as AppLocalePlugin & typeof plugin, emit: (tag: string | null) => listener?.({ tag }) }
}

describe('app language sync with Android', () => {
  beforeEach(() => {
    platform.android = true
  })

  it('adopts the language set in Android at startup', async () => {
    const i18n = fakeI18n('en')
    await syncAppLanguageFromNative(i18n as unknown as I18n, fakePlugin({ supported: true, tag: 'pl' }).plugin)
    expect(i18n.changeLanguage).toHaveBeenCalledWith('pl')
  })

  it('maps the tag Android reports onto a shipped language', async () => {
    const i18n = fakeI18n('en')
    await syncAppLanguageFromNative(i18n as unknown as I18n, fakePlugin({ supported: true, tag: 'pt' }).plugin)
    expect(i18n.changeLanguage).toHaveBeenCalledWith('pt-PT')
  })

  it('leaves the language alone when the app follows the system', async () => {
    const i18n = fakeI18n('de')
    await syncAppLanguageFromNative(i18n as unknown as I18n, fakePlugin({ supported: true, tag: null }).plugin)
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
  })

  it('does nothing below Android 13', async () => {
    const i18n = fakeI18n('de')
    const { plugin } = fakePlugin({ supported: false, tag: 'pl' })
    await syncAppLanguageFromNative(i18n as unknown as I18n, plugin)
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
    expect(plugin.addListener).not.toHaveBeenCalled()
  })

  it('follows a change made in Android Settings while running', async () => {
    const i18n = fakeI18n('en')
    const { plugin, emit } = fakePlugin({ supported: true, tag: null })
    await syncAppLanguageFromNative(i18n as unknown as I18n, plugin)
    emit('uk')
    expect(i18n.changeLanguage).toHaveBeenCalledWith('uk')
  })

  it('ignores the echo of its own change', async () => {
    const i18n = fakeI18n('fr')
    const { plugin, emit } = fakePlugin({ supported: true, tag: 'fr' })
    await syncAppLanguageFromNative(i18n as unknown as I18n, plugin)
    emit('fr')
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
  })

  it('hands an explicit pick to Android', async () => {
    const { plugin } = fakePlugin({ supported: true })
    await setNativeAppLanguage('zh-CN', plugin)
    expect(plugin.set).toHaveBeenCalledWith({ tag: 'zh-CN' })
  })

  it('stays off Android entirely elsewhere', async () => {
    platform.android = false
    const i18n = fakeI18n('en')
    const { plugin } = fakePlugin({ supported: true, tag: 'pl' })
    await syncAppLanguageFromNative(i18n as unknown as I18n, plugin)
    await setNativeAppLanguage('pl', plugin)
    expect(plugin.get).not.toHaveBeenCalled()
    expect(plugin.set).not.toHaveBeenCalled()
  })
})

describe('following iOS language changes', () => {
  const store = (seen?: string) => {
    const m = new Map<string, string>(seen ? [[IOS_LANGUAGE_SEEN_KEY, seen]] : [])
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  beforeEach(() => {
    platform.android = false
    platform.ios = true
  })

  it('adopts a language changed in iOS Settings since the last launch', () => {
    const i18n = fakeI18n('en')
    followIOSLanguageChanges(i18n as unknown as I18n, 'pl-PL', store('en-US'))
    expect(i18n.changeLanguage).toHaveBeenCalledWith('pl')
  })

  it('keeps an in-app choice while the iOS language stays the same', () => {
    const i18n = fakeI18n('uk')
    followIOSLanguageChanges(i18n as unknown as I18n, 'en-US', store('en-US'))
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
  })

  it('only records the language on the first launch, so existing choices stand', () => {
    const i18n = fakeI18n('de')
    const s = store()
    followIOSLanguageChanges(i18n as unknown as I18n, 'en-US', s)
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
    expect(s.m.get(IOS_LANGUAGE_SEEN_KEY)).toBe('en-US')
  })

  it('maps the iOS tag onto a shipped language', () => {
    const i18n = fakeI18n('en')
    followIOSLanguageChanges(i18n as unknown as I18n, 'zh-Hans-CN', store('en-US'))
    expect(i18n.changeLanguage).toHaveBeenCalledWith('zh-CN')
  })

  it('does nothing off iOS', () => {
    platform.ios = false
    const i18n = fakeI18n('en')
    followIOSLanguageChanges(i18n as unknown as I18n, 'pl-PL', store('en-US'))
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
  })
})
