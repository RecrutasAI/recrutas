import { useEffect, useState } from "react";
import {
  Search,
  Shield,
  Zap,
  Target,
  Brain,
  MapPin,
  Sparkles,
  Ban,
  FileText,
  Compass,
  KeyRound,
  UserCheck,
  Coffee,
  type LucideIcon,
} from "lucide-react";

export interface HypeMessage {
  icon: LucideIcon;
  text: string;
}

// Default copy for the matches feed. Reinforces the candidate-first
// "if you apply, you know where you stand today" thesis while making the
// work feel real (named ATSes, real filters).
export const MATCHING_MESSAGES: HypeMessage[] = [
  { icon: Search, text: "Skipping the recruiters..." },
  { icon: Zap, text: "Pulling roles straight from company boards..." },
  { icon: Shield, text: "Filtering out ghost jobs..." },
  { icon: Target, text: "Scoring roles against your skills..." },
  { icon: Ban, text: "Ignoring anywhere that ghosts applicants..." },
  { icon: Brain, text: "Matching to titles you've actually held..." },
  { icon: MapPin, text: "Keeping it US-only..." },
  { icon: Sparkles, text: "Surfacing the ones worth your Sunday..." },
];

export const RESUME_MESSAGES: HypeMessage[] = [
  { icon: FileText, text: "Reading your résumé..." },
  { icon: Brain, text: "Extracting skills and titles..." },
  { icon: Compass, text: "Mapping you to real open roles..." },
  { icon: Sparkles, text: "Almost there, building your candidate vector..." },
];

export const SIGN_IN_MESSAGES: HypeMessage[] = [
  { icon: KeyRound, text: "Verifying your session..." },
  { icon: UserCheck, text: "Loading your candidate profile..." },
  { icon: Coffee, text: "Hold tight, pouring your matches..." },
  { icon: Sparkles, text: "Setting up your dashboard..." },
];

interface LoadingHypeProps {
  /** Rotating messages. Defaults to MATCHING_MESSAGES. */
  messages?: HypeMessage[];
  /** Static caption shown under the bar when no rotation desired. */
  staticText?: string;
  /** ms per message. */
  intervalMs?: number;
  className?: string;
  /** Render compact (smaller, for inline use). */
  compact?: boolean;
}

/**
 * Creative loading state. Instead of a circle spinner, shows an
 * indeterminate gradient bar that flows left→right with rotating copy.
 * Use this anywhere a meaningful (>~400ms) wait happens.
 */
export function LoadingHype({
  messages = MATCHING_MESSAGES,
  staticText,
  intervalMs = 2500,
  className = "",
  compact = false,
}: LoadingHypeProps) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (staticText) return;
    const t = setInterval(() => setIdx(i => (i + 1) % messages.length), intervalMs);
    return () => clearInterval(t);
  }, [messages.length, intervalMs, staticText]);

  const current = messages[idx] ?? messages[0];
  const Icon = current?.icon ?? Search;
  const text = staticText ?? current?.text ?? "Loading...";

  const barWidth = compact ? "w-40" : "w-64";
  const padY = compact ? "py-6" : "py-16";

  return (
    <div className={`flex flex-col items-center justify-center ${padY} ${className}`}>
      {/* Indeterminate progress — gradient slug travels left to right */}
      <div
        className={`relative ${barWidth} h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800 mb-5`}
      >
        <div
          className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-emerald-500 to-blue-500"
          style={{ animation: "lh-slide 1.4s ease-in-out infinite" }}
        />
      </div>

      {/* Rotating message — fade-in transition triggered by key change */}
      <div
        key={idx}
        className="flex items-center gap-2.5"
        style={{ animation: "lh-fade-in 400ms ease-out" }}
      >
        <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{text}</p>
      </div>

      {/* Local keyframes — scoped to this component via unique prefix. */}
      <style>{`
        @keyframes lh-slide {
          0%   { left: -33%; }
          100% { left: 100%; }
        }
        @keyframes lh-fade-in {
          from { opacity: 0; transform: translateY(2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
