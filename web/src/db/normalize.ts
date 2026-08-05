// NFD splits a letter into its base and a combining mark, so stripping the
// marks folds every Slovak diacritic onto the plain letter: á ä č ď é í ĺ ľ
// ň ó ô ŕ š ť ú ý ž. ADR 0005: nobody types `é` into a search box, so
// `diskretna` has to find `Diskrétna matematika`.
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
