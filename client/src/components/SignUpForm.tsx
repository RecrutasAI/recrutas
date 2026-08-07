
import { useState, useMemo, useEffect } from "react";
import { useSupabaseClient } from "@supabase/auth-helpers-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Eye, EyeOff, Check, X, Loader2 } from "lucide-react";
import { track } from "@/lib/analytics";

/** Read ?code= from URL query params (e.g. recrutas.ai/signup/candidate?code=REDDIT-A1B2C3) */
function getCodeFromURL(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get('code') || '').toUpperCase();
}

interface SignUpFormProps {
  role: 'candidate' | 'talent_owner';
}

// Password strength checker
function getPasswordStrength(password: string): { score: number; label: string; color: string; requirements: { met: boolean; text: string }[] } {
  const requirements = [
    { met: password.length >= 8, text: "At least 8 characters" },
    { met: /[A-Z]/.test(password), text: "One uppercase letter" },
    { met: /[a-z]/.test(password), text: "One lowercase letter" },
    { met: /[0-9]/.test(password), text: "One number" },
  ];

  const score = requirements.filter(r => r.met).length;

  if (score <= 1) {return { score, label: "Weak", color: "bg-red-500", requirements };}
  if (score === 2) {return { score, label: "Fair", color: "bg-orange-500", requirements };}
  if (score === 3) {return { score, label: "Good", color: "bg-yellow-500", requirements };}
  return { score, label: "Strong", color: "bg-green-500", requirements };
}

export default function SignUpForm({ role }: SignUpFormProps) {
  const supabase = useSupabaseClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(getCodeFromURL);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // Also pick up code if user navigates with ?code= after initial render
  useEffect(() => {
    const urlCode = getCodeFromURL();
    if (urlCode && !inviteCode) setInviteCode(urlCode);
  }, []);

  const passwordStrength = useMemo(() => getPasswordStrength(password), [password]);

  const handleSignUp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            role,
            first_name: firstName,
            last_name: lastName,
            full_name: `${firstName} ${lastName}`.trim(),
          },
          emailRedirectTo: `${window.location.origin}/`,
        },
      });
      if (error) {throw error;}
      // Bootstrap user record in local DB. The code is optional — sent only for
      // attribution when the signup came from a tagged link.
      if (data.session?.access_token) {
        const code = inviteCode.trim();
        const syncRes = await fetch('/api/auth/sync', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${data.session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(code ? { inviteCode: code } : {}),
        });
        if (!syncRes.ok) {
          const syncData = await syncRes.json().catch(() => ({ message: 'Sync failed' }));
          // Only reachable with INVITE_GATE on server-side; open signup never 403s here.
          if (syncData.code === 'INVITE_REQUIRED' || syncData.code === 'INVITE_INVALID') {
            await supabase.auth.signOut();
            throw new Error(syncData.message || 'Invalid invite code');
          }
        }

        track('signup_completed', { role, ...(code ? { invite_code: code } : {}) });
        // Redirect to guided setup to complete profile
        setLocation("/guided-setup");
      } else if (data.user && !data.session) {
        // Email confirmation required - show message but don't redirect
        toast({
          title: "Account created",
          description: "Please check your email to verify your account before signing in.",
        });
      }
    } catch (error: unknown) {
      toast({
        title: "Error signing up",
        description: (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="space-y-6" onSubmit={handleSignUp}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="firstName"
            className="block text-sm font-medium text-muted-foreground"
          >
            First name
          </label>
          <div className="mt-1">
            <input
              id="firstName"
              name="firstName"
              type="text"
              autoComplete="given-name"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="appearance-none block w-full px-3 py-2 border border-input rounded-md shadow-sm placeholder-muted-foreground focus:outline-none focus:ring-ring focus:border-ring sm:text-sm bg-input text-foreground"
            />
          </div>
        </div>
        <div>
          <label
            htmlFor="lastName"
            className="block text-sm font-medium text-muted-foreground"
          >
            Last name
          </label>
          <div className="mt-1">
            <input
              id="lastName"
              name="lastName"
              type="text"
              autoComplete="family-name"
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="appearance-none block w-full px-3 py-2 border border-input rounded-md shadow-sm placeholder-muted-foreground focus:outline-none focus:ring-ring focus:border-ring sm:text-sm bg-input text-foreground"
            />
          </div>
        </div>
      </div>

      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium text-muted-foreground"
        >
          Email
        </label>
        <div className="mt-1">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="appearance-none block w-full px-3 py-2 border border-input rounded-md shadow-sm placeholder-muted-foreground focus:outline-none focus:ring-ring focus:border-ring sm:text-sm bg-input text-foreground"
          />
        </div>
      </div>

      {/*
        The Invite Code field is gone (2026-08-07): signup is open, and a
        required code field is the thing that stopped strangers signing up.
        A `?code=` in the URL is still captured and sent for attribution — it is
        just no longer something we make people type.

        NOTE: if INVITE_GATE is ever turned back on server-side, there is no
        field here to enter a code in, so gated signups must arrive via a
        `?code=` link. Restore an input below if that stops being true.
      */}

      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-muted-foreground"
        >
          Password
        </label>
        <div className="mt-1 relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="appearance-none block w-full px-3 py-2 pr-10 border border-input rounded-md shadow-sm placeholder-muted-foreground focus:outline-none focus:ring-ring focus:border-ring sm:text-sm bg-input text-foreground"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Password Strength Indicator */}
        {password && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${passwordStrength.color}`}
                  style={{ width: `${(passwordStrength.score / 4) * 100}%` }}
                />
              </div>
              <span className={`text-xs font-medium ${
                passwordStrength.score <= 1 ? 'text-red-500' :
                passwordStrength.score === 2 ? 'text-orange-500' :
                passwordStrength.score === 3 ? 'text-yellow-500' : 'text-green-500'
              }`}>
                {passwordStrength.label}
              </span>
            </div>
            <ul className="space-y-1">
              {passwordStrength.requirements.map((req, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  {req.met ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <X className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className={req.met ? 'text-green-500' : 'text-muted-foreground'}>
                    {req.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <button
          type="submit"
          disabled={loading}
          className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring"
        >
          {loading ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin inline" />Signing up...</>
          ) : 'Sign up'}
        </button>
      </div>
    </form>
  );
}
