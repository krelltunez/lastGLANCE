import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import HttpBackend from 'i18next-http-backend'
import { applyDateLocale } from '@/utils/datetime'
import { languages, resolveLanguage } from '@/locales'

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

export default i18n
