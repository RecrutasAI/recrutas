import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Users, Briefcase, MessageSquare, Star, Target, Calendar,
  Linkedin, Github, Globe, ExternalLink, Trophy, ChevronDown, ChevronUp, Sparkles, Clock, AlertCircle
} from "lucide-react";
import type { JobPosting } from "./types";

interface CandidatesTabProps {
  selectedJob: JobPosting | null;
  applicants: any[];
  applicantsLoading: boolean;
  applicantsWithSeparator: any[];
  totalRanked: number;
  maxChat: number;
  expandedApplicantId: number | null;
  setExpandedApplicantId: (id: number | null) => void;
  screeningQuestions: { [key: number]: string[] } | undefined;
  handleUpdateStatus: (applicationId: number, status: string) => void;
  startChatMutation: any;
  generateQuestionsMutation: any;
  setScheduleApplicant: (data: { applicationId: number; candidateId: string; name: string } | null) => void;
  setScheduleInterviewOpen: (open: boolean) => void;
}

function scoreBadgeClass(score: number) {
  if (score >= 80) return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800";
  if (score >= 60) return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800";
  return "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800";
}

function getInitials(firstName: string, lastName: string) {
  return `${firstName?.[0] || ''}${lastName?.[0] || ''}`.toUpperCase() || '?';
}

function DeadlineBadge({ responseDeadlineAt }: { responseDeadlineAt?: string | null }) {
  if (!responseDeadlineAt) return null;
  const deadline = new Date(responseDeadlineAt);
  const msLeft = deadline.getTime() - Date.now();
  if (msLeft <= 0) {
    return (
      <Badge variant="outline" className="text-xs px-1.5 py-0 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800 animate-pulse">
        <AlertCircle className="h-3 w-3 mr-1" />
        Overdue
      </Badge>
    );
  }
  const hoursLeft = Math.ceil(msLeft / (1000 * 60 * 60));
  const isUrgent = hoursLeft <= 6;
  return (
    <Badge variant="outline" className={`text-xs px-1.5 py-0 ${isUrgent ? 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800' : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800'}`}>
      <Clock className="h-3 w-3 mr-1" />
      {hoursLeft}h left
    </Badge>
  );
}

export default function CandidatesTab({
  selectedJob,
  applicants,
  applicantsLoading,
  applicantsWithSeparator,
  totalRanked,
  maxChat,
  expandedApplicantId,
  setExpandedApplicantId,
  screeningQuestions,
  handleUpdateStatus,
  startChatMutation,
  generateQuestionsMutation,
  setScheduleApplicant,
  setScheduleInterviewOpen,
}: CandidatesTabProps) {
  if (!selectedJob) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-12 text-center">
        <div className="h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
          <Briefcase className="h-6 w-6 text-gray-400" />
        </div>
        <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">Select a Job to View Applicants</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Go to the Jobs tab and click "Applicants" on any posting.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            {selectedJob.title}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {applicants.length} applicant{applicants.length !== 1 ? 's' : ''} · {selectedJob.company}
          </p>
        </div>
        {selectedJob.hasExam && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 text-xs font-medium text-amber-700 dark:text-amber-400 shrink-0">
            <Trophy className="h-3.5 w-3.5" />
            Top {maxChat} unlock chat
          </div>
        )}
      </div>

      {applicantsLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 animate-pulse">
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-full bg-gray-100 dark:bg-gray-800 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded w-1/4" />
                  <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/3" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : applicants.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-12 text-center">
          <div className="h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
            <Users className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">No applicants yet</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">As soon as candidates apply, you'll see them here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {applicantsWithSeparator.map((item: any) => {
            if (item._separator) {
              return (
                <div key="cutoff-separator" className="flex items-center gap-3 py-3">
                  <div className="flex-1 border-t border-dashed border-gray-200 dark:border-gray-700" />
                  <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap px-1">
                    Below top {maxChat}: chat locked
                  </span>
                  <div className="flex-1 border-t border-dashed border-gray-200 dark:border-gray-700" />
                </div>
              );
            }

            const applicant = item;
            const isExpanded = expandedApplicantId === applicant.applicationId;
            const questions = screeningQuestions?.[applicant.candidate.id];
            const firstName = applicant.candidate?.firstName || 'Unknown';
            const lastName = applicant.candidate?.lastName || '';

            return (
              <div
                key={applicant.applicationId}
                className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden"
              >
                {/* Main row */}
                <div className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                    {/* Avatar + name */}
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="h-10 w-10 rounded-full bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center shrink-0 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                        {getInitials(firstName, lastName)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900 dark:text-white">
                            {firstName} {lastName}
                          </span>
                          {/* Score badges */}
                          {applicant.examScore != null && (
                            <Badge variant="outline" className={`text-xs px-1.5 py-0 ${scoreBadgeClass(applicant.examScore)}`}>
                              <Target className="h-3 w-3 mr-1" />
                              {applicant.examScore}%
                            </Badge>
                          )}
                          {applicant.examRanking != null && (
                            <Badge variant="outline" className={`text-xs px-1.5 py-0 ${applicant.qualifiedForChat ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800" : "bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700"}`}>
                              <Trophy className="h-3 w-3 mr-1" />
                              #{applicant.examRanking}/{totalRanked}
                          </Badge>
                          )}
                          {applicant.qualifiedForChat && (
                            <DeadlineBadge responseDeadlineAt={applicant.responseDeadlineAt} />
                          )}
                          {applicant.match?.matchScore && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800">
                              <Star className="h-3 w-3 mr-1" />
                              {applicant.match.matchScore} match
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{applicant.candidate?.email || ''}</p>

                        {/* Skills */}
                        {(applicant.profile?.skills || []).length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {(applicant.profile?.skills || []).slice(0, 5).map((skill: string) => (
                              <span key={skill} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                                {skill}
                              </span>
                            ))}
                            {(applicant.profile?.skills || []).length > 5 && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500">
                                +{(applicant.profile?.skills || []).length - 5}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Professional links */}
                        {(applicant.profile?.linkedinUrl || applicant.profile?.githubUrl || applicant.profile?.portfolioUrl) && (
                          <div className="flex items-center gap-2 mt-2">
                            {applicant.profile?.linkedinUrl && (
                              <a href={applicant.profile.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded text-xs transition-colors">
                                <Linkedin className="h-3 w-3" />LinkedIn<ExternalLink className="h-2 w-2" />
                              </a>
                            )}
                            {applicant.profile?.githubUrl && (
                              <a href={applicant.profile.githubUrl} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300 rounded text-xs transition-colors">
                                <Github className="h-3 w-3" />GitHub<ExternalLink className="h-2 w-2" />
                              </a>
                            )}
                            {applicant.profile?.portfolioUrl && (
                              <a href={applicant.profile.portfolioUrl} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:hover:bg-emerald-900 dark:text-emerald-400 rounded text-xs transition-colors">
                                <Globe className="h-3 w-3" />Portfolio<ExternalLink className="h-2 w-2" />
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Status selector */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        defaultValue={applicant.status}
                        onValueChange={(newStatus) => handleUpdateStatus(applicant.applicationId, newStatus)}
                      >
                        <SelectTrigger className="w-44 h-8 text-xs border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                          <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="submitted">Submitted</SelectItem>
                          <SelectItem value="viewed">Viewed</SelectItem>
                          <SelectItem value="screening">Screening</SelectItem>
                          <SelectItem value="interview_scheduled">Interview Scheduled</SelectItem>
                          <SelectItem value="interview_completed">Interview Completed</SelectItem>
                          <SelectItem value="offer">Offer</SelectItem>
                          <SelectItem value="rejected">Rejected</SelectItem>
                          <SelectItem value="withdrawn">Withdrawn</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Action row */}
                  <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                    {(!selectedJob?.hasExam || applicant.qualifiedForChat) ? (
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={() => selectedJob && startChatMutation.mutate({ jobId: selectedJob.id, candidateId: applicant.candidate?.id })}
                        disabled={startChatMutation.isPending}
                      >
                        <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                        Chat
                      </Button>
                    ) : (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button size="sm" variant="outline" className="h-7 text-xs" disabled>
                                <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                                Chat Locked
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Top {maxChat} candidates unlock chat.</p>
                            <p>Ranked #{applicant.examRanking ?? '?'} of {totalRanked}.</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                      onClick={() => {
                        setScheduleApplicant({
                          applicationId: applicant.applicationId,
                          candidateId: applicant.candidate?.id,
                          name: `${firstName} ${lastName}`.trim()
                        });
                        setScheduleInterviewOpen(true);
                      }}
                    >
                      <Calendar className="h-3.5 w-3.5 mr-1.5" />
                      Interview
                    </Button>

                    {applicant.match?.aiExplanation && (
                      <button
                        className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors ml-auto"
                        onClick={() => setExpandedApplicantId(isExpanded ? null : applicant.applicationId)}
                      >
                        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                        AI Insights
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded AI insights */}
                {isExpanded && (
                  <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-4 py-4 space-y-4">
                    {applicant.match?.aiExplanation && (
                      <div>
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                          <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                          AI Match Explanation
                        </p>
                        <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{applicant.match.aiExplanation}</p>
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-gray-200 dark:border-gray-700"
                        onClick={() => selectedJob && generateQuestionsMutation.mutate({ jobId: selectedJob.id, candidateId: applicant.candidate?.id })}
                        disabled={generateQuestionsMutation.isPending || !selectedJob}
                      >
                        <Sparkles className="h-3.5 w-3.5 mr-1.5 text-amber-500" />
                        Generate Screening Questions
                      </Button>
                    </div>

                    {questions && questions.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Suggested Questions</p>
                        <ol className="space-y-1.5">
                          {questions.map((q, i) => (
                            <li key={i} className="flex gap-2 text-sm text-gray-600 dark:text-gray-400">
                              <span className="shrink-0 text-xs font-medium text-gray-400 dark:text-gray-500 w-4">{i + 1}.</span>
                              {q}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
