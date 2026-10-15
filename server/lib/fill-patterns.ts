/**
 * Which profile value a form field asks for, from its label (and name/id), for the fill's
 * pattern matcher, used when the AI is unavailable and to backfill fields the AI skipped.
 *
 * Labels are real: Ashby's "Full legal name" (Coder) and Lever's "Legal First Name✱" (Hermeus)
 * both went unfilled on 2026-10-15 because the name patterns only knew "Full name", "Name"
 * and "Your name", and Lever's required mark "✱" broke the anchored patterns.
 */
export type ProfileKey = 'firstName' | 'lastName' | 'fullName' | 'email' | 'phone' | 'linkedin' | 'github'
  | 'portfolio' | 'location' | 'currentTitle' | 'currentCompany' | 'school' | 'degree' | 'todayDate';

const PATTERNS: [ProfileKey, RegExp[]][] = [
  // Checked first: "First and last name" is one full name, not a last name.
  // "Name", "Full name", "Full legal name", "Legal name", "Your full name", "Candidate name",
  // "First and last name". Not "Preferred name", "Company name", "Reference name".
  ['fullName', [/^(?:(?:your|full|legal|complete|candidate'?s?|applicant'?s?)\s+)*name(?:\s*\(.*\))?$/i, /^first\s*(?:and|&)\s*last\s+name/i]],
  ['firstName', [/first[\s_-]?name/i, /fname/i, /given[\s_-]?name/i]],
  ['lastName', [/last[\s_-]?name/i, /lname/i, /surname/i, /family[\s_-]?name/i]],
  // The date beside a signature (Lever's disability form: "Name" + "Date"): today.
  ['todayDate', [/^date$/i, /\bsignature date\b|\bdate signed\b|\btoday'?s date\b/i]],
  ['email', [/e[\s_-]?mail/i]],
  ['phone', [/phone/i, /telephone/i, /mobile/i, /cell/i]],
  ['linkedin', [/linkedin/i]],
  ['github', [/github/i]],
  ['portfolio', [/portfolio/i, /personal[\s_-]?site/i, /^website$/i]],
  // City-level only: a street "Address" field must not get "Seattle, WA".
  ['location', [/^location\b/i, /^city\b/i, /^current (?:location|city)\b/i, /^where are you (?:located|based)/i]],
  ['currentTitle', [/current[\s_-]?title/i, /job[\s_-]?title/i, /^title$/i]],
  ['currentCompany', [/current[\s_-]?(company|employer)/i, /^company$/i]],
  ['school', [/school/i, /university/i, /institution/i, /college/i]],
  ['degree', [/degree/i, /education/i]],
];

/** The label alone, without required marks and punctuation, so anchored patterns see "Name". */
export function cleanFieldLabel(label: string): string {
  return label.replace(/[*:✱]/g, '').replace(/\(required\)/ig, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first profile key whose patterns match the field, among those the profile has a value for. */
export function profileKeyFor(field: { label?: string; name?: string; id?: string }, has: (k: ProfileKey) => boolean): ProfileKey | null {
  const labelText = cleanFieldLabel(field.label || '');
  const blob = `${field.label || ''} ${field.name || ''} ${field.id || ''}`.toLowerCase();
  for (const [key, patterns] of PATTERNS) {
    if (has(key) && patterns.some(p => p.test(blob) || p.test(labelText))) {return key;}
  }
  return null;
}
