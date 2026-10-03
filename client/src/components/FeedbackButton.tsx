import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { MessageSquare } from 'lucide-react';
import { useSession } from '@supabase/auth-helpers-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

// Public marketing pages carry feedback in their footer instead of a
// floating button, which covered page content there.
const PUBLIC_SITE_ROUTES = ['/', '/manifesto', '/privacy', '/terms'];

const RULE = 'border-neutral-200 dark:border-neutral-800';

// Labels shown to people; values are what /api/feedback accepts.
const TYPES: { value: 'Bug' | 'Suggestion' | 'Other'; label: string }[] = [
  { value: 'Bug', label: 'Bug' },
  { value: 'Suggestion', label: 'Idea' },
  { value: 'Other', label: 'Other' },
];

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('Bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const signedInEmail = session?.user?.email;

  const reset = () => { setType('Bug'); setMessage(''); setEmail(''); setState('idle'); setError(''); };
  const close = (next: boolean) => { onOpenChange(next); if (!next) { setTimeout(reset, 200); } };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) {return;}
    setState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          message,
          userEmail: signedInEmail || email.trim() || undefined,
          userName: session?.user?.user_metadata?.full_name,
        }),
      });
      // The old form reported success even when this was a 429 or a 500.
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 429
          ? "You've sent a lot of feedback in a short time. Try again in a few minutes."
          : body.error || 'Something went wrong. Please try again.');
      }
      setState('sent');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={`sm:max-w-md rounded-none border ${RULE} bg-white dark:bg-black p-0 gap-0 font-geist`}>
        <div className={`px-6 pt-6 pb-4 border-b ${RULE}`}>
          <div className="font-geist-mono text-[11px] uppercase tracking-[0.16em] text-neutral-500 mb-2">Feedback</div>
          <DialogTitle className="text-xl font-semibold tracking-tight">Tell us what's off.</DialogTitle>
          <DialogDescription className="text-sm text-neutral-500 mt-1">
            Every message goes straight to the team. We read all of them.
          </DialogDescription>
        </div>

        {state === 'sent' ? (
          <div className="px-6 py-8">
            <p className="font-geist-mono text-[12px] uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400 mb-2">● Sent</p>
            <p className="text-neutral-700 dark:text-neutral-300">
              Thank you. {signedInEmail || email.trim() ? "If it needs a reply, we'll email you." : 'We read every message.'}
            </p>
            <button
              onClick={() => close(false)}
              className={`mt-6 h-10 px-4 border ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] hover:border-neutral-900 dark:hover:border-white transition-colors`}
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
            <div className={`grid grid-cols-3 border-t border-l ${RULE}`} role="radiogroup" aria-label="Feedback type">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={type === t.value}
                  onClick={() => setType(t.value)}
                  className={`h-9 border-r border-b ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                    type === t.value
                      ? 'bg-neutral-900 text-white dark:bg-white dark:text-black'
                      : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div>
              <label htmlFor="feedback-message" className="sr-only">Your feedback</label>
              <textarea
                id="feedback-message"
                required
                rows={5}
                maxLength={5000}
                value={message}
                onChange={(e) => { setMessage(e.target.value); if (state === 'error') {setState('idle');} }}
                placeholder={type === 'Bug' ? 'What happened, and what did you expect?' : type === 'Suggestion' ? 'What would make Recrutas better for you?' : "What's on your mind?"}
                className={`w-full resize-none border ${RULE} bg-transparent px-3 py-2 text-[15px] leading-relaxed outline-none focus:border-neutral-900 dark:focus:border-white placeholder:text-neutral-400 transition-colors`}
              />
            </div>

            {!signedInEmail && (
              <div>
                <label htmlFor="feedback-email" className="block font-geist-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500 mb-1.5">
                  Email <span className="normal-case tracking-normal">(optional, if you'd like a reply)</span>
                </label>
                <input
                  id="feedback-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={`w-full h-10 border ${RULE} bg-transparent px-3 text-sm outline-none focus:border-neutral-900 dark:focus:border-white placeholder:text-neutral-400 transition-colors`}
                />
              </div>
            )}

            {state === 'error' && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

            <button
              type="submit"
              disabled={state === 'sending' || !message.trim()}
              className="w-full h-11 bg-emerald-600 text-white text-[15px] font-medium hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600 transition-colors"
            >
              {state === 'sending' ? 'Sending…' : 'Send feedback'}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Floating trigger for the app pages; the public site uses its footer link. */
export function FeedbackButton() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  if (PUBLIC_SITE_ROUTES.includes(location)) {return null;}

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`fixed bottom-20 right-4 sm:bottom-5 sm:right-5 z-50 flex items-center gap-2 h-9 px-3 border ${RULE} bg-white/90 dark:bg-black/90 backdrop-blur font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white hover:border-neutral-900 dark:hover:border-white transition-colors`}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        Feedback
      </button>
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
