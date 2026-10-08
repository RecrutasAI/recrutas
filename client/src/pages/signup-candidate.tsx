
import SignUpForm from "@/components/SignUpForm";
import { GoogleSignInButton, OrDivider } from "@/components/google-sign-in-button";
import SmartLogo from "@/components/smart-logo";
import { UsOnlyGate } from "@/components/us-only-gate";
import { Briefcase } from "lucide-react";
import { useSiteStatus } from "@/hooks/use-site-status";
import { SignupWaitlist } from "@/components/signup-waitlist";

export default function SignUpCandidatePage() {
  // The admin console's sign-up waitlist switch: new accounts wait, existing users sign in as usual.
  const { signupWaitlist } = useSiteStatus();
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            <SmartLogo size={40} />
          </div>
          <div className="flex items-center justify-center gap-2 mb-2">
            <Briefcase className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold">Sign up as a Candidate</h1>
          </div>
          <p className="text-muted-foreground">Find your next job opportunity.</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-6 shadow-lg">
          <UsOnlyGate>
            {signupWaitlist ? <SignupWaitlist /> : (
              <>
                <GoogleSignInButton label="Sign up with Google" />
                <OrDivider />
                <SignUpForm role="candidate" />
              </>
            )}
          </UsOnlyGate>
        </div>
        <div className="text-center mt-4">
          <a href="/auth" className="text-sm font-medium text-primary hover:text-primary/90">
            Already have an account? Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
