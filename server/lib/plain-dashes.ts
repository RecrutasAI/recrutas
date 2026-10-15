/**
 * No en or em dashes in text we write for a candidate: Abas (2026-10-15), "a good AI post
 * indicator". AI drafts love them, and a draft goes to an employer under the candidate's name.
 * Between numbers a dash is a range ("5–10" → "5-10"); anywhere else it becomes a comma.
 */
export function plainDashes(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(?=\d)/g, '$1-')
    .replace(/\s*[–—]+\s*/g, ', ')
    .replace(/,\s*([.,;:!?])/g, '$1')
    .replace(/^,\s*|,\s*$/g, '')
    .trim();
}
