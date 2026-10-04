// First US-style phone number in free text, formatted as written. Requires a
// separator-free or conventionally separated 10-digit run so years and IDs
// ("2019-2023", "744000151423519") don't qualify.
export function phoneFromText(text?: string | null): string {
  if (!text) return '';
  const m = text.match(/(?<![\d-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\d-])/);
  return m ? m[0].trim() : '';
}
