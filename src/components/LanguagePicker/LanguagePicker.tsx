import { useTranslation } from 'react-i18next'
import { languages, resolveLanguage } from '@/locales'
import { nativeLanguageName } from './nativeLanguageName'

/**
 * One picker for every surface that offers a language choice, so the desktop
 * header and the mobile settings sheet cannot drift apart. Persistence is
 * i18next's own localStorage cache — changeLanguage writes it, the detector
 * reads it back on the next launch.
 */
export function LanguagePicker({ className, id }: { className?: string; id?: string }) {
  const { i18n } = useTranslation()
  // Same resolver the detector uses, so the option shown always matches the
  // language actually rendering. A select whose value matches no option
  // silently displays its first entry instead.
  const value = resolveLanguage(i18n.resolvedLanguage || i18n.language)

  return (
    <select
      id={id}
      value={value}
      onChange={e => i18n.changeLanguage(e.target.value)}
      className={className}
    >
      {languages.map(lng => (
        <option key={lng} value={lng}>
          {nativeLanguageName(lng)}
        </option>
      ))}
    </select>
  )
}
