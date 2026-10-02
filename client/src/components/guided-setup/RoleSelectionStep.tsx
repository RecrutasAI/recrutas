
import { useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, Building, Loader2 } from 'lucide-react';
import { useGuidedSetup } from '@/contexts/GuidedSetupContext';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useLocation } from 'wouter';
import { supabase } from '@/lib/supabase-client';

// Employer access is closed while phase 1 (candidates) is live — employers
// join the homepage interest list, and nothing public links to employer
// signup. So an account that arrives here without a role (e.g. a first
// "Continue with Google" from /auth) is a candidate. Flip to true to offer
// the candidate / talent-owner choice again.
export const EMPLOYER_SELF_SERVE = false;

export default function RoleSelectionStep() {
  const [_location, _setLocation] = useLocation();
  const { setRole, setStep } = useGuidedSetup();
  const { toast } = useToast();

  const setRoleMutation = useMutation({
    mutationFn: async (role: 'candidate' | 'talent_owner') => {
      // apiRequest resolves on any HTTP status, so a failed save has to be
      // turned into an error here or the flow starts with no role stored.
      const res = await apiRequest('POST', '/api/auth/role', { role });
      if (!res.ok) {throw new Error(`Role save failed (${res.status})`);}
      // The server records the role in app_metadata, but this tab's token was
      // minted before that. Without a fresh token RoleGuard sees no role at the
      // end of onboarding and sends the user back to step 1 (it did, for an
      // hour, until the token refreshed on its own). Not fatal: RoleGuard also
      // reads the role from the users row.
      await supabase.auth.refreshSession().catch(() => {});
      await queryClient.invalidateQueries({ queryKey: ['/api/auth/user'] });
      return role;
    },
    onSuccess: (_role) => {
      if (EMPLOYER_SELF_SERVE) {
        toast({
          title: 'Role selected!',
          description: 'Your profile has been updated.',
        });
      }

      // Step 1, not 2. This screen is a gate that runs BEFORE the step machine,
      // not its first step: once a role exists the flow becomes the 2-step
      // candidate (Resume → Profile) or talent-owner (Company → Post Job) set.
      // Sending them to step 2 would skip résumé upload — the one action the
      // whole candidate flow exists to collect.
      setStep(1);
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to save your role. Please try again.',
        variant: 'destructive',
      });
    },
  });

  const handleSelectRole = (role: 'candidate' | 'talent_owner') => {
    setRole(role);
    setRoleMutation.mutate(role);
  };

  // Candidate-only mode: save the role once, and only move on when it is
  // stored — setting it locally first would start the candidate flow for an
  // account the server still has no role for.
  const autoAssigned = useRef(false);
  useEffect(() => {
    if (EMPLOYER_SELF_SERVE || autoAssigned.current) {return;}
    autoAssigned.current = true;
    setRoleMutation.mutate('candidate', { onSuccess: () => setRole('candidate') });
  }, []);

  if (!EMPLOYER_SELF_SERVE) {
    return (
      <div className="flex flex-col items-center gap-4 py-10 text-center">
        {setRoleMutation.isError ? (
          <>
            <p className="text-muted-foreground">We couldn't finish setting up your account.</p>
            <Button onClick={() => setRoleMutation.mutate('candidate', { onSuccess: () => setRole('candidate') })}>
              Try again
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Setting up your candidate account…</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-center mb-6">Choose Your Role</h2>
      <div className="grid md:grid-cols-2 gap-8">
        <Card
          className={`cursor-pointer transition-all duration-200 hover:shadow-xl bg-card border border-border hover:ring-2 hover:ring-primary ${setRoleMutation.isPending ? 'opacity-50 pointer-events-none' : ''}`}
          onClick={() => handleSelectRole('candidate')}
        >
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-4 w-16 h-16 bg-primary rounded-full flex items-center justify-center">
              <Users className="w-8 h-8 text-primary-foreground" />
            </div>
            <CardTitle className="text-2xl">I'm a Candidate</CardTitle>
            <p className="text-muted-foreground">Looking for job opportunities</p>
          </CardHeader>
        </Card>

        <Card
          className={`cursor-pointer transition-all duration-200 hover:shadow-xl bg-card border border-border hover:ring-2 hover:ring-primary ${setRoleMutation.isPending ? 'opacity-50 pointer-events-none' : ''}`}
          onClick={() => handleSelectRole('talent_owner')}
        >
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-4 w-16 h-16 bg-primary rounded-full flex items-center justify-center">
              <Building className="w-8 h-8 text-primary-foreground" />
            </div>
            <CardTitle className="text-2xl">I'm a Talent Owner</CardTitle>
            <p className="text-muted-foreground">Hiring talent for my company</p>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}
