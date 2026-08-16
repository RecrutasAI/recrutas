
import { createContext, useContext, useState, useEffect } from 'react';
import { useSessionContext } from '@supabase/auth-helpers-react';

interface GuidedSetupContextType {
  step: number;
  setStep: React.Dispatch<React.SetStateAction<number>>;
  role: 'candidate' | 'talent_owner' | null;
  setRole: React.Dispatch<React.SetStateAction<'candidate' | 'talent_owner' | null>>;
  isLoading: boolean;
}

const GuidedSetupContext = createContext<GuidedSetupContextType | undefined>(undefined);

export function GuidedSetupProvider({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<'candidate' | 'talent_owner' | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Supabase hydrates the session asynchronously and reports that with its own
  // `isLoading`. Ignoring it means treating "not loaded yet" as "no session",
  // which resolves role to null and makes consumers act on an answer that is
  // merely early — a signed-in candidate gets asked to pick a role they already
  // chose at signup.
  const { session, isLoading: sessionLoading } = useSessionContext();

  useEffect(() => {
    if (sessionLoading) {
      setIsLoading(true);
      return;
    }
    const userRole = session?.user?.user_metadata?.role;
    if (userRole === 'candidate' || userRole === 'talent_owner') {
      setRole(userRole);
    }
    setIsLoading(false);
  }, [session, sessionLoading]);

  return (
    <GuidedSetupContext.Provider value={{ step, setStep, role, setRole, isLoading }}>
      {children}
    </GuidedSetupContext.Provider>
  );
}

export function useGuidedSetup() {
  const context = useContext(GuidedSetupContext);
  if (!context) {
    throw new Error('useGuidedSetup must be used within a GuidedSetupProvider');
  }
  return context;
}
