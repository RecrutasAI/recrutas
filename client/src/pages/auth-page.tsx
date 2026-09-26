import { useState, useEffect } from "react";
import { useSupabaseClient, useSession } from "@supabase/auth-helpers-react";
import { useLocation } from "wouter";
import SmartLogo from "@/components/smart-logo";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { GoogleSignInButton, OrDivider } from "@/components/google-sign-in-button";
import { LoadingHype, SIGN_IN_MESSAGES } from "@/components/loading-hype";

export default function AuthPage() {
  const supabase = useSupabaseClient();
  const session = useSession();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [signInLoading, setSignInLoading] = useState(false);
  // Shown inline (not a toast) so it stays until the user edits a field.
  const [signInError, setSignInError] = useState<null | { credentials: boolean; message: string }>(null);


  // Forward ?code= param to signup links
  const codeParam = new URLSearchParams(window.location.search).get('code');
  const codeSuffix = codeParam ? `?code=${encodeURIComponent(codeParam)}` : '';

  useEffect(() => {
    if (session) {
      const userRole = session.user?.user_metadata?.role;
      if (userRole === 'candidate') {
        setLocation("/candidate-dashboard");
      } else if (userRole === 'talent_owner' || userRole === 'recruiter') {
        setLocation("/talent-dashboard");
      } else {
        setLocation("/role-selection");
      }
    }
  }, [session, setLocation]);

  const handleSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSignInLoading(true);
    setSignInError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {throw error;}
    } catch (error: unknown) {
      console.error("Sign-in error:", error);
      const message = (error as Error).message;
      setSignInError({ credentials: /invalid login credentials/i.test(message), message });
    } finally {
      setSignInLoading(false);
    }
  };



  if (session) {
    // Show creative loading state while redirecting — same component as the
    // role-guard so the sign-in → dashboard transition feels continuous.
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <LoadingHype messages={SIGN_IN_MESSAGES} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <SmartLogo size={40} />
          </div>
          <p className="text-sm text-muted-foreground">Sign in to your account</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-8 shadow-lg">
          <GoogleSignInButton />
          <OrDivider />
          <form className="space-y-6" onSubmit={handleSignIn}>
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
                  onChange={(e) => { setEmail(e.target.value); setSignInError(null); }}
                  className="appearance-none block w-full px-3 py-2 border border-input rounded-md shadow-sm placeholder-muted-foreground focus:outline-none focus:ring-ring focus:border-ring sm:text-sm bg-input text-foreground"
                />
              </div>
            </div>

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
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setSignInError(null); }}
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
              <div className="flex items-center justify-between mt-2">
                <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-input bg-input text-primary focus:ring-primary"
                  />
                  Remember me
                </label>
                <a href="/forgot-password" className="text-sm font-medium text-primary hover:text-primary/90">
                  Forgot password?
                </a>
              </div>
            </div>
            {signInError && (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
                {signInError.credentials ? (
                  <>
                    <p className="font-medium">That email and password don't match.</p>
                    <p className="mt-1 text-muted-foreground">
                      Check for typos, reset it with "Forgot password?", or use Google if that's how you signed up.
                      Not sure which email you used? Try the one you job-hunt with, or email{" "}
                      <a href="mailto:support@recrutas.ai" className="underline">support@recrutas.ai</a>.
                    </p>
                  </>
                ) : (
                  <p>{signInError.message}</p>
                )}
              </div>
            )}

            <div className="flex flex-col items-center space-y-4">
              <button
                type="submit"
                disabled={signInLoading}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring"
              >
                {signInLoading ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin inline" />Signing in...</>
                ) : 'Sign in'}
              </button>
              <div className="text-center text-sm">
                <p className="text-muted-foreground mb-4">Don't have an account?</p>
                <div className="flex flex-col space-y-2">
                  <a href={`/signup/candidate${codeSuffix}`} className="w-full inline-flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:border-gray-600">
                    Sign up as a Candidate
                  </a>
                  <a href={`/signup/talent-owner${codeSuffix}`} className="w-full inline-flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:border-gray-600">
                    Sign up as a Talent Owner
                  </a>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}