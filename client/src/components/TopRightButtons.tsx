import React from 'react';
import { useSession } from '@supabase/auth-helpers-react';
import { SignOutButton } from './SignOutButton';
import { ThemeToggleButton } from './theme-toggle-button';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight, Home } from 'lucide-react';
import { useLocation } from 'wouter';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function TopRightButtons() {
  const session = useSession();
  const [location, setLocation] = useLocation();

  // Hide on admin pages — admin dashboard has its own header with sign out
  if (location.startsWith('/admin')) return null;
  // The public site pages carry their own navigation and theme toggle.
  if (['/', '/manifesto', '/privacy', '/terms'].includes(location)) return null;

  const handleHomeClick = () => {
    if (session) {
      // Get role from user metadata
      const role = session.user?.user_metadata?.role || session.user?.app_metadata?.role;

      if (role === 'talent_owner' || role === 'recruiter') {
        setLocation('/talent-dashboard');
      } else if (role === 'candidate') {
        setLocation('/candidate-dashboard');
      } else {
        // No role set yet, go to role selection
        setLocation('/role-selection');
      }
    } else {
      // Non-authenticated users go to landing page
      setLocation('/');
    }
  };

  return (
    <TooltipProvider>
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => history.back()}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go Back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => history.forward()}>
              <ArrowRight className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go Forward</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={handleHomeClick}>
              <Home className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {session ? 'Go to Dashboard' : 'Go to Home'}
          </TooltipContent>
        </Tooltip>

        {session && <SignOutButton />}
        <ThemeToggleButton />
      </div>
    </TooltipProvider>
  );
}
