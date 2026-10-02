import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { LoadingHype, SIGN_IN_MESSAGES } from '@/components/loading-hype';
import { getUserRole } from '@/lib/auth-role';

interface RoleGuardProps {
  allowedRoles: ('candidate' | 'talent_owner' | 'recruiter')[];
  children: React.ReactNode;
  fallbackPath?: string;
}

export function RoleGuard({ allowedRoles, children, fallbackPath = '/' }: RoleGuardProps) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const userRole = getUserRole(user as any);

  useEffect(() => {
    if (isLoading) {return;}

    if (!isAuthenticated) {
      setLocation('/auth');
      return;
    }

    if (!userRole) {
      setLocation('/role-selection');
      return;
    }

    if (!allowedRoles.includes(userRole as any)) {
      toast({
        title: 'Access Denied',
        description: 'You do not have permission to access this page.',
        variant: 'destructive',
      });
      setLocation(fallbackPath);
      return;
    }
  }, [isAuthenticated, userRole, allowedRoles, setLocation, toast, isLoading, fallbackPath]);

  if (isLoading || !isAuthenticated || !userRole || !allowedRoles.includes(userRole as any)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingHype messages={SIGN_IN_MESSAGES} />
      </div>
    );
  }

  return <>{children}</>;
}
