import { useEffect } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { GuidedSetupProvider, useGuidedSetup } from '@/contexts/GuidedSetupContext';
import SkillsStep from '@/components/guided-setup/SkillsStep';
import CompanyProfileStep from '@/components/guided-setup/CompanyProfileStep';
import ResumeUploadStep from '@/components/guided-setup/ResumeUploadStep';
import JobPostStep from '@/components/guided-setup/JobPostStep';
import RoleSelectionStep from '@/components/guided-setup/RoleSelectionStep';

import { ChevronLeft, Loader2 } from 'lucide-react';
import { SignOutButton } from '@/components/SignOutButton';
import { ThemeToggleButton } from '@/components/theme-toggle-button';
import { Button } from '@/components/ui/button';
import { useSessionContext } from '@supabase/auth-helpers-react';

/** Shared page chrome, so the loading and role-gate states don't lose the header. */
function SetupShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center p-4">
      <div className="w-full max-w-2xl flex justify-end items-center mb-8 pt-4">
        <div className="flex gap-2">
          <ThemeToggleButton />
          <SignOutButton />
        </div>
      </div>
      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-foreground">{title}</h1>
          <p className="text-lg text-muted-foreground">{subtitle}</p>
        </div>
        <Card>
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}

function GuidedSetupContent() {
  const { step, role, setRole, setStep, isLoading } = useGuidedSetup();
  const { session } = useSessionContext();

  // Initialize role from signup metadata if available
  useEffect(() => {
    if (session?.user?.user_metadata?.role) {
      const userRole = session.user.user_metadata.role;
      if (userRole === 'candidate' || userRole === 'talent_owner') {
        setRole(userRole);
      }
    }
  }, [session, setRole]);

  const candidateSteps = [
    { name: 'Resume', component: <ResumeUploadStep /> },
    { name: 'Profile', component: <SkillsStep /> },
  ];

  const talentOwnerSteps = [
    { name: 'Company', component: <CompanyProfileStep /> },
    { name: 'Post Job', component: <JobPostStep /> },
  ];

  // The role is resolved from the session asynchronously, so it is null on the
  // first render of every visit. Never guess a flow from an unresolved role:
  // this component used to fall through to the talent-owner steps whenever role
  // wasn't exactly 'candidate', which meant every candidate entering onboarding
  // was shown "Company / Post a Job" until the session hydrated.
  if (isLoading) {
    return (
      <SetupShell title="Welcome to Recrutas" subtitle="Getting your account ready…">
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </SetupShell>
    );
  }

  // Role resolved but absent — the account has no role metadata at all. `/auth`
  // routes exactly these users here (via /role-selection), and with no gate they
  // landed in the employer flow with no way out, because RoleSelectionStep was
  // never wired in. Ask instead of assuming.
  if (role === null) {
    return (
      <SetupShell title="Welcome to Recrutas" subtitle="First, tell us how you'll be using Recrutas.">
        <RoleSelectionStep />
      </SetupShell>
    );
  }

  const isCandidate = role === 'candidate';
  const steps = isCandidate ? candidateSteps : talentOwnerSteps;
  const clampedStep = Math.max(1, Math.min(step, steps.length));
  if (clampedStep !== step) {setStep(clampedStep);}
  const currentStep = steps[clampedStep - 1];
  const progress = (clampedStep / steps.length) * 100;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center p-4">
      {/* Header Bar */}
      <div className="w-full max-w-2xl flex justify-between items-center mb-8 pt-4">
        <Button
          variant="ghost"
          onClick={() => setStep(clampedStep - 1)}
          disabled={clampedStep <= 1}
          className={clampedStep <= 1 ? 'invisible' : ''}
        >
          <ChevronLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <div className="flex gap-2">
          <ThemeToggleButton />
          <SignOutButton />
        </div>
      </div>

      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-foreground">
            {clampedStep === 1 ? 'Welcome to Recrutas' : 'Complete Your Profile'}
          </h1>
          <p className="text-lg text-muted-foreground">
            {clampedStep === 1
              ? "Let's get your profile set up."
              // Was hardcoded to the company line, so candidates were asked about
              // "your company" on the skills step of a candidate-only flow.
              : isCandidate
                ? 'Add your skills so we can match you to jobs.'
                : 'Tell us about your company to get started.'}
          </p>
        </div>
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center mb-6">
              {steps.map((s, idx) => {
                const stepNum = idx + 1;
                const isActive = stepNum === clampedStep;
                const isCompleted = stepNum < clampedStep;

                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => setStep(stepNum)}
                    className={`flex items-center gap-2 group cursor-pointer ${isActive ? 'text-primary' : isCompleted ? 'text-green-600' : 'text-muted-foreground'}`}
                  >
                    <div className={`
                      w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors
                      ${isActive ? 'border-primary bg-primary text-primary-foreground' :
                        isCompleted ? 'border-green-600 bg-green-600 text-white' :
                          'border-muted-foreground/30 bg-background'}
                    `}>
                      {isCompleted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : (
                        <span>{stepNum}</span>
                      )}
                    </div>
                    <span className="font-medium hidden sm:block">{s.name}</span>
                  </button>
                );
              })}
            </div>
            <Progress value={progress} className="w-full" />
          </CardHeader>
          <CardContent>
            {currentStep.component}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function GuidedSetup() {
  return (
    <GuidedSetupProvider>
      <GuidedSetupContent />
    </GuidedSetupProvider>
  );
}
