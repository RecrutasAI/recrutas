import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Shown instead of sign-up while the admin console's "Sign-up waitlist" switch
 * is on. People who already have an account are not affected.
 */
export function SignupWaitlist({ email: initialEmail = '' }: { email?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) { setState('error'); setMessage('Enter your email.'); return; }
    setState('sending');
    try {
      const r = await fetch('/api/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'signup-waitlist' }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {throw new Error(body.error || 'Something went wrong. Try again in a minute.');}
      setState('done');
      setMessage(body.message || "You're on the list. We'll email you as soon as a spot opens.");
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Something went wrong. Try again in a minute.');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">We're letting people in in waves</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          A lot of people are signing up right now. Leave your email and we'll let you in as soon as there's room, usually within a day.
        </p>
      </div>
      {state === 'done' ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
      ) : (
        <form onSubmit={join} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="waitlist-email">Email</Label>
            <Input id="waitlist-email" type="email" autoComplete="email" value={email} onChange={e => { setEmail(e.target.value); if (state === 'error') {setState('idle');} }} />
          </div>
          {state === 'error' && <p role="alert" className="text-sm text-red-600">{message}</p>}
          <Button type="submit" className="w-full" disabled={state === 'sending'}>
            {state === 'sending' ? 'Joining…' : 'Join the waitlist'}
          </Button>
        </form>
      )}
    </div>
  );
}
