/** Case/accents/underscore-insensitive key used for every name comparison. */
export function fold(s: string): string {
  return (s || '')
    .replace(/_/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]s\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
