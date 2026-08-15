import {
  Dialog,
  DialogContent,
  DialogHeader,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  MapPin,
  DollarSign,
  Briefcase,
  ExternalLink,
  Shield,
  Building2,
  Zap,
  Clock,
  Brain,
  Target,
  GraduationCap,
  Compass,
  Sparkles,
} from "lucide-react";
import { AIJobMatch } from "./ai-job-feed";
import { stripHtml } from "@/utils/string.utils";

// Strip HTML tags from requirement strings
// stripHtml lives in utils/string.utils — this file used to carry its own copy
// that stripped tags before decoding entities, which rendered raw markup to
// candidates on entity-escaped postings.

// SVG donut ring for the score
function ScoreRing({ score }: { score: number }) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color =
    score >= 75 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  const trackColor = score >= 75 ? "#dcfce7" : score >= 50 ? "#fef3c7" : "#fee2e2";

  return (
    <div className="relative w-24 h-24 flex-shrink-0">
      <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} fill="none" stroke={trackColor} strokeWidth="10" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold" style={{ color }}>{score}%</span>
        <span className="text-xs text-slate-400 font-medium">match</span>
      </div>
    </div>
  );
}

function ScoreBar({
  label,
  score,
  icon: Icon,
  hint,
}: {
  label: string;
  score: number;
  icon: React.ComponentType<{ className?: string }>;
  hint?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const color =
    clamped >= 75 ? "bg-green-500" : clamped >= 50 ? "bg-amber-500" : "bg-slate-400";
  const textColor =
    clamped >= 75
      ? "text-green-700 dark:text-green-400"
      : clamped >= 50
        ? "text-amber-700 dark:text-amber-400"
        : "text-slate-500 dark:text-slate-400";
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <Icon className="h-3.5 w-3.5" />
          <span className="font-medium">{label}</span>
          {hint && (
            <span className="text-slate-400 dark:text-slate-500 font-normal">
              · {hint}
            </span>
          )}
        </div>
        <span className={`text-xs font-semibold tabular-nums ${textColor}`}>
          {clamped}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function VerdictBadge({ score }: { score: number }) {
  if (score >= 75)
    {return (
      <Badge className="bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800 text-xs font-semibold px-3 py-1">
        <Zap className="h-3 w-3 mr-1" />
        Strong Match
      </Badge>
    );}
  if (score >= 50)
    {return (
      <Badge className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800 text-xs font-semibold px-3 py-1">
        Good Fit
      </Badge>
    );}
  return (
    <Badge className="bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 text-xs font-semibold px-3 py-1">
      Worth Exploring
    </Badge>
  );
}

interface AIMatchBreakdownModalProps {
  match: AIJobMatch | null;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export default function AIMatchBreakdownModal({
  match,
  isOpen,
  onOpenChange,
}: AIMatchBreakdownModalProps) {
  if (!match) {return null;}

  const score = parseInt(match.matchScore) || 0;
  const jobSkills: string[] = match.job.skills || [];
  const matchedSkills: string[] = match.skillMatches || [];
  const relatedSkills: string[] = match.partialSkillMatches || [];
  const matchedSet = new Set(
    [...matchedSkills, ...relatedSkills].map((s) => s.toLowerCase())
  );
  const missingSkills = jobSkills.filter(
    (s) => !matchedSet.has(s.toLowerCase())
  );

  const requirements = (match.job.requirements || [])
    .map(stripHtml)
    .filter(Boolean)
    .slice(0, 4);

  // Split the server-side explanation ("part1. part2. part3") into bullets.
  const explanationPoints = (match.aiExplanation || "")
    .split(/\.\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Short description excerpt — strip HTML, collapse whitespace.
  const descriptionExcerpt = match.job.description
    ? stripHtml(match.job.description).replace(/\s+/g, " ").slice(0, 280)
    : "";

  const components = match.scoreComponents;

  const salary =
    match.job.salaryMin || match.job.salaryMax
      ? [
          match.job.salaryMin
            ? `$${Math.round(match.job.salaryMin / 1000)}k`
            : null,
          match.job.salaryMax
            ? `$${Math.round(match.job.salaryMax / 1000)}k`
            : null,
        ]
          .filter(Boolean)
          .join(" – ")
      : null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[580px] max-h-[90vh] overflow-y-auto p-0 gap-0 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 space-y-0">
          <div className="flex items-start gap-4">
            {/* Job info */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap gap-2 mb-2">
                <VerdictBadge score={score} />
                {match.isVerifiedActive && (
                  <Badge variant="outline" className="text-xs border-green-200 text-green-700 dark:border-green-800 dark:text-green-400">
                    <Shield className="h-3 w-3 mr-1" />
                    Verified Active
                  </Badge>
                )}
                {match.isDirectFromCompany && (
                  <Badge variant="outline" className="text-xs border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-400">
                    <Building2 className="h-3 w-3 mr-1" />
                    Direct Apply
                  </Badge>
                )}
              </div>
              <h2 className="font-bold text-lg text-slate-900 dark:text-white leading-tight truncate">
                {match.job.title}
              </h2>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">
                {match.job.company}
              </p>
              {/* Job meta */}
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-500 dark:text-slate-400">
                {match.job.location && (
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {match.job.location}
                  </span>
                )}
                {match.job.workType && (
                  <span className="flex items-center gap-1">
                    <Briefcase className="h-3 w-3" />
                    {match.job.workType}
                  </span>
                )}
                {salary && (
                  <span className="flex items-center gap-1">
                    <DollarSign className="h-3 w-3" />
                    {salary}
                  </span>
                )}
                {match.job.postedDate && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {(() => {
                      const days = Math.floor((Date.now() - new Date(match.job.postedDate!).getTime()) / 86400000);
                      return days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;
                    })()}
                  </span>
                )}
              </div>
            </div>
            {/* Score ring */}
            <ScoreRing score={score} />
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-5">
          {/* Divider */}
          <div className="border-t border-slate-100 dark:border-slate-800" />

          {/* Score breakdown — only when scorer components are present */}
          {components && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
                Score breakdown
              </h3>
              <div className="space-y-3">
                <ScoreBar
                  label="Skills"
                  hint="direct keyword overlap"
                  icon={Target}
                  score={components.keywordScore}
                />
                <ScoreBar
                  label="Profile similarity"
                  hint={components.hasSemanticSignal ? "AI embedding match" : "no embedding yet"}
                  icon={Brain}
                  score={components.semanticScore}
                />
                <ScoreBar
                  label="Role relevance"
                  hint="title & role family"
                  icon={Sparkles}
                  score={components.titleScore}
                />
                <ScoreBar
                  label="Experience level"
                  icon={GraduationCap}
                  score={components.experienceScore}
                />
                {components.contextBonus > 0 && (
                  <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 pt-1">
                    <div className="flex items-center gap-1.5">
                      <Compass className="h-3.5 w-3.5" />
                      <span className="font-medium">Location & work-type fit</span>
                    </div>
                    <span className="font-semibold text-green-700 dark:text-green-400 tabular-nums">
                      +{components.contextBonus}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Why this match — split into bullets */}
          {explanationPoints.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Why this match
              </h3>
              <ul className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-3 space-y-1.5">
                {explanationPoints.map((point, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                    <span className="leading-snug">{point.replace(/\.$/, '')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Skills analysis */}
          <div>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
              Skills analysis
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {/* Matched */}
              <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                  <span className="text-xs font-semibold text-green-700 dark:text-green-400">
                    You have ({matchedSkills.length})
                  </span>
                </div>
                {matchedSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {matchedSkills.slice(0, 8).map((skill) => (
                      <span
                        key={skill}
                        className="inline-block text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 rounded-md px-2 py-0.5"
                      >
                        {skill}
                      </span>
                    ))}
                    {matchedSkills.length > 8 && (
                      <span className="text-xs text-green-600 dark:text-green-400">
                        +{matchedSkills.length - 8} more
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-green-600 dark:text-green-400 italic">
                    Add skills to your profile
                  </p>
                )}
              </div>

              {/* Missing */}
              <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <XCircle className="h-4 w-4 text-slate-400" />
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    To develop ({missingSkills.length})
                  </span>
                </div>
                {missingSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {missingSkills.slice(0, 8).map((skill) => (
                      <span
                        key={skill}
                        className="inline-block text-xs bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 rounded-md px-2 py-0.5"
                      >
                        {skill}
                      </span>
                    ))}
                    {missingSkills.length > 8 && (
                      <span className="text-xs text-slate-400">
                        +{missingSkills.length - 8} more
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 italic">
                    You match all listed skills
                  </p>
                )}
              </div>
            </div>

            {/* Related skills row */}
            {relatedSkills.length > 0 && (
              <div className="mt-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                    Related skills you have ({relatedSkills.length})
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {relatedSkills.slice(0, 10).map((skill) => (
                    <span
                      key={skill}
                      className="inline-block text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 rounded-md px-2 py-0.5"
                    >
                      {skill}
                    </span>
                  ))}
                  {relatedSkills.length > 10 && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      +{relatedSkills.length - 10} more
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* About the role */}
          {descriptionExcerpt && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                About the role
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                {descriptionExcerpt}
                {match.job.description && stripHtml(match.job.description).length > 280 ? "…" : ""}
              </p>
            </div>
          )}

          {/* Key requirements */}
          {requirements.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Key requirements
              </h3>
              <ul className="space-y-1.5">
                {requirements.map((req, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-400"
                  >
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-slate-400 flex-shrink-0" />
                    <span className="leading-snug">{req}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-slate-100 dark:border-slate-800" />

          {/* Actions */}
          <div className="flex gap-3">
            {match.job.externalUrl ? (
              <a
                href={match.job.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
              >
                <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white gap-2">
                  Apply Now
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </a>
            ) : (
              <Button
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                onClick={() => onOpenChange(false)}
              >
                Apply on Recrutas
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-slate-200 dark:border-slate-700"
            >
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
