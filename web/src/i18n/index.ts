import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en.ts'
import { sk } from './sk.ts'

export const languages = ['sk', 'en'] as const
export type Language = (typeof languages)[number]

// Czech readers are served Slovak rather than English: the languages are
// mutually intelligible and the audience is Slovak.
function detect(): Language {
  const tag = navigator.language.toLowerCase()
  if (tag.startsWith('en')) return 'en'
  return 'sk'
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, sk: { translation: sk } },
  lng: detect(),
  fallbackLng: 'sk',
  // Keys are flat identifiers like `app.title`, so the dot must not be read
  // as nesting.
  keySeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

export default i18n
