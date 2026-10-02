import { useSession } from "@supabase/auth-helpers-react";
import RecrutasLogo, { RecrutasLogoCompact } from "./recrutas-logo";
import { getUserRole } from "@/lib/auth-role";

interface SmartLogoProps {
  size?: number;
  className?: string;
  showText?: boolean;
}

export default function SmartLogo({ size = 32, className = "", showText = true }: SmartLogoProps) {
  const session = useSession();
  const user = session?.user;

  const handleClick = () => {
    let target = "/";
    if (user) {
      const role = getUserRole(user);
      target = role === "talent_owner" || role === "recruiter"
        ? "/talent-dashboard"
        : "/candidate-dashboard";
    }
    window.location.href = target;
  };

  return (
    <button 
      onClick={handleClick}
      className={`flex items-center space-x-2 hover:opacity-80 transition-opacity cursor-pointer ${className}`}
      title="Go to home"
    >
      {showText ? (
        <RecrutasLogoCompact size={size} />
      ) : (
        <RecrutasLogo size={size} />
      )}
    </button>
  );
}

// Header component for pages that need it
export function Header({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <header className={`bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 ${className}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <SmartLogo />
          {children}
        </div>
      </div>
    </header>
  );
}
