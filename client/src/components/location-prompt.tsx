import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocationPicker } from '@/components/location-picker';
import { apiRequest } from '@/lib/queryClient';

interface LocationPromptProps {
  /** The location read from the resume, offered for confirmation only (never saved on its own). */
  suggestion?: string | null;
}

/**
 * Asks for the one setting that changes the feed most when it's missing. Setup requires it, but
 * people leave setup early (2026-10-14: a test account reached a nationwide feed with none set).
 * The resume's location is offered, not assumed: the parser can pick up an employer's city
 * (resume.service.ts never auto-fills location for that reason).
 */
export function LocationPrompt({ suggestion }: LocationPromptProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(suggestion?.trim() || '');
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('recrutas_location_prompt_dismissed') === '1'; } catch { return false; }
  });
  const save = useMutation({
    mutationFn: async (location: string) => {
      const res = await apiRequest('POST', '/api/candidate/profile', { location });
      if (!res.ok) {throw new Error('Could not save your location. Try again.');}
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/profile'] });
      queryClient.invalidateQueries({ queryKey: ['/api/ai-matches'] });
    },
  });
  if (dismissed || save.isSuccess) {return null;}
  const dismiss = () => {
    try { sessionStorage.setItem('recrutas_location_prompt_dismissed', '1'); } catch { /* storage blocked */ }
    setDismissed(true);
  };

  return (
    <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 p-4" data-testid="location-prompt">
      <p className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
        <MapPin className="h-4 w-4 text-blue-600 dark:text-blue-400" /> Where are you looking for work?
      </p>
      <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
        Jobs near you rank higher. Without a location your matches come from anywhere in the US.
        {suggestion?.trim() ? ` Your resume says ${suggestion.trim()}; change it if that's not where you're looking.` : ''}
      </p>
      <div className="mt-3 flex flex-col sm:flex-row gap-2">
        <div className="flex-1 min-w-0"><LocationPicker value={value} onChange={setValue} placeholder="City, state or Remote" /></div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" onClick={() => save.mutate(value)} disabled={!value.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
        </div>
      </div>
      {save.isError && <p className="mt-2 text-xs text-red-600" role="alert">{(save.error as Error).message}</p>}
    </div>
  );
}
