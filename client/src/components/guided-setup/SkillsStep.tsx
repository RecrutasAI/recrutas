import { useLocation } from 'wouter';
import ProfileWizard from '@/components/profile-wizard';
import { apiRequest } from '@/lib/queryClient';

export default function SkillsStep() {
  const [, setLocation] = useLocation();

  const handleComplete = async () => {
    try {
      await apiRequest('POST', '/api/candidate/profile/complete');
    } catch (e) {
      // Non-fatal — redirect regardless
      console.warn('[SkillsStep] Failed to mark profile complete:', e);
    }
    setLocation('/candidate-dashboard');
  };

  return (
    <div>
      <ProfileWizard onComplete={handleComplete} skipResumeStep />
    </div>
  );
}
