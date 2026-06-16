/**
 * Pure helpers for the extension fill-form endpoint.
 * Kept in their own module (no heavy imports) so they're unit-testable in isolation.
 */

// A file field is résumé-targetable unless it's clearly for another document
// (cover letter, transcript, writing sample, portfolio, photo/headshot). Used by
// the fill-form guard so a résumé is never attached to a cover-letter input.
export function isResumeFileField(field?: { id?: string; label?: string; name?: string }): boolean {
  if (!field) return false;
  const text = `${field.label || ''} ${field.name || ''} ${field.id || ''}`.toLowerCase();
  return !/cover[\s_-]?letter|coverletter|transcript|writing[\s_-]?sample|portfolio|photo|headshot/.test(text);
}
