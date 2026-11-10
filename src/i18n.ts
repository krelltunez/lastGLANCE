import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import HttpBackend from 'i18next-http-backend'
import { applyDateLocale, loadTimeFormat, loadWeekStart, setSystemClock, setSystemWeekStart } from '@/utils/datetime'
import { languages, resolveLanguage } from '@/locales'
import { followIOSLanguageChanges, syncAppLanguageFromNative } from '@/native/appLocale'
import { getSystemClock, getSystemWeekStart } from '@/native/widgetBridge'

// The user's 12/24-hour choice, read before the first date is formatted.
loadTimeFormat()
// And the week-start choice, before the first grid is built.
loadWeekStart()

// Keep date handling on the same language as the UI strings. Registered before
// .init() so this listener runs ahead of react-i18next's own — the locale is
// already switched by the time it re-renders, so no frame paints a date in the
// language the user just left.
i18n.on('languageChanged', applyDateLocale)

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    // Derived from the locale files on disk (src/locales.ts) — a hand-kept
    // list here is how sibling app dayGLANCE shipped translations no user
    // could reach.
    supportedLngs: languages,
    ns: ['translation'],
    defaultNS: 'translation',
    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      // Runs on every detection source, the localStorage cache included, so
      // whatever tag is stored or reported is mapped onto a language that
      // actually ships. The picker resolves its value through the same
      // function, so the option it shows always matches what renders.
      convertDetectedLanguage: (lng: string) => resolveLanguage(lng),
    },
  })

// Detection resolves during .init(), which can settle before the listener above
// is reached on some paths; seed from the resolved language so the very first
// render is already correct.
applyDateLocale(i18n.language)

// On Android 13+, a language chosen in Settings > Apps > lastGLANCE > Language
// wins over the cached one, at startup and live. No-op everywhere else.
void syncAppLanguageFromNative(i18n)
// On iOS, a language change in Settings > lastGLANCE > Language (or the
// phone's language) is adopted at the next launch. No-op everywhere else.
followIOSLanguageChanges(i18n)

// On Android and iOS, Automatic week start follows the operating system, which
// knows the region and any first-day override even when the WebView's language
// tag does not (issue #362). Re-read on return to the app, since it can change
// in system settings meanwhile. No-op on web.
const readSystemWeekStart = () => { void getSystemWeekStart().then(setSystemWeekStart) }
readSystemWeekStart()
// Automatic time format follows the OS clock the same way (the phones and the
// desktop app; the web keeps the language's clock). The first read is awaited
// before the first paint (main.tsx), so times never paint on the wrong clock.
const readSystemClock = () => getSystemClock().then(setSystemClock, () => {})
export const systemClockRead: Promise<void> = readSystemClock()
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { readSystemWeekStart(); void readSystemClock() }
  })
}

export default i18n
