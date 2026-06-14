import { useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Calendar, Clock, Eye, MessageSquare, ExternalLink, ChevronRight, FileText, Loader2, Trash2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { formatDistanceToNow } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ApplicationStatus {
  id: number;
  status: string;
  appliedAt: string;
  viewedByEmployerAt?: string;
  lastStatusUpdate: string;
  interviewDate?: string;
  autoFilled?: boolean;
  metadata?: Record<string, any>;
  chatRoomId?: number | null;
  job: {
    id: number;
    title: string;
    company: string;
    location: string;
    salaryMin?: number;
    salaryMax?: number;
    workType: string;
    externalUrl?: string;
    hasExam?: boolean;
  };
  match?: {
    matchScore: string;
    confidenceLevel: string;
  };
}

const statusConfig: Record<string, { label: string; color: string; progress: number }> = {
  queued: { label: "Queued — submitting in ~5 min", color: "bg-amber-500", progress: 3 },
  submitting: { label: "Submitting...", color: "bg-amber-500", progress: 5 },
  applied: { label: "Submitted", color: "bg-blue-500", progress: 10 },
  submitted: { label: "Submitted", color: "bg-blue-500", progress: 10 },
  viewed: { label: "Viewed", color: "bg-yellow-500", progress: 25 },
  screening: { label: "In Review", color: "bg-orange-500", progress: 40 },
  interview_scheduled: { label: "Interview Scheduled", color: "bg-purple-500", progress: 60 },
  interview_completed: { label: "Interview Complete", color: "bg-indigo-500", progress: 80 },
  offer: { label: "Offer Received", color: "bg-green-500", progress: 100 },
  rejected: { label: "Not Selected", color: "bg-red-500", progress: 0 },
  withdrawn: { label: "Withdrawn", color: "bg-gray-500", progress: 0 }
};

export default function ApplicationTracker() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: applications, isLoading, isError } = useQuery<ApplicationStatus[]>({
    queryKey: ["/api/candidate/applications"],
    // 5s poll while submitting, otherwise no polling (no employers yet)
    refetchInterval: (query) => {
      const apps = query.state.data;
      const hasPending = apps?.some(app => app.status === 'submitting' || app.status === 'queued');
      return hasPending ? 5000 : false;
    },
  });

  const clearClosedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('DELETE', '/api/candidate/applications/closed');
      if (!res.ok) {throw new Error('Failed to clear past applications');}
      return res.json();
    },
    onSuccess: (data: { deletedCount?: number }) => {
      toast({
        title: "Past Applications Cleared",
        description: `Removed ${data?.deletedCount ?? 0} past application${data?.deletedCount === 1 ? '' : 's'}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/candidate/applications"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to clear past applications.", variant: "destructive" });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ applicationId, status }: { applicationId: number; status: string }) => {
      // Use candidate-specific endpoint for self-service status update
      const res = await apiRequest('PUT', `/api/candidate/application/${applicationId}/status`, { status });
      if (!res.ok) {throw new Error('Failed to update status');}
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status Updated", description: "Your application status has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/candidate/applications"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update status.", variant: "destructive" });
    },
  });

  // These memos MUST be declared before any conditional returns (Rules of Hooks)
  const activeApplications = useMemo(() => (applications || []).filter(app =>
    !['rejected', 'withdrawn'].includes(app.status)
  ), [applications]);
  const closedApplications = useMemo(() => (applications || []).filter(app =>
    ['rejected', 'withdrawn'].includes(app.status)
  ), [applications]);

  const getStatusBadge = (status: string) => {
    const config = statusConfig[status] || statusConfig.submitted;
    return (
      <Badge variant="secondary" className="flex items-center gap-1">
        {(status === 'submitting' || status === 'queued') ? (
          <Loader2 className="h-3 w-3 animate-spin text-amber-600" />
        ) : (
          <div className={`w-2 h-2 rounded-full ${config.color}`} />
        )}
        {config.label}
      </Badge>
    );
  };

  const getProgressPercentage = (status: string) => {
    return statusConfig[status]?.progress || 0;
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader>
              <div className="h-4 bg-gray-200 rounded w-3/4"></div>
              <div className="h-3 bg-gray-200 rounded w-1/2"></div>
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <div className="text-gray-500">
            <Calendar className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <h3 className="text-lg font-medium mb-2">Could not load applications</h3>
            <p className="text-sm mb-4">Something went wrong. Please try again.</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!applications || applications.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <div className="text-gray-500">
            <Calendar className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <h3 className="text-lg font-medium mb-2">No Applications Yet</h3>
            <p className="text-sm">Start applying to jobs to track your progress here</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-blue-600">{applications.length}</div>
            <div className="text-sm text-gray-600">Total Applications</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-orange-600">{activeApplications.length}</div>
            <div className="text-sm text-gray-600">In Progress</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-purple-600">
              {applications.filter(app => app.status === 'interview_scheduled').length}
            </div>
            <div className="text-sm text-gray-600">Interviews</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-green-600">
              {applications.filter(app => app.status === 'offer').length}
            </div>
            <div className="text-sm text-gray-600">Offers</div>
          </CardContent>
        </Card>
      </div>

      {/* Active Applications */}
      {activeApplications.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Active Applications ({activeApplications.length})
          </h3>
          <div className="space-y-4">
            {activeApplications.map((application) => (
              <Card key={application.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{application.job?.title || 'Unknown Job'}</CardTitle>
                      <CardDescription className="flex items-center gap-2 mt-1">
                        <span>{application.job?.company || 'Unknown Company'}</span>
                        {application.job?.location && (
                          <>
                            <span>•</span>
                            <span>{application.job.location}</span>
                          </>
                        )}
                        {application.job?.workType && (
                          <>
                            <span>•</span>
                            <span className="capitalize">{application.job.workType}</span>
                          </>
                        )}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {application.match && (
                        <Badge variant="outline" className="text-xs">
                          {application.match.matchScore}% match
                        </Badge>
                      )}
                      {getStatusBadge(application.status)}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-3">
                    {/* Progress bar */}
                    {(() => {
                      const pct = getProgressPercentage(application.status);
                      return pct > 0 ? (
                        <div className="space-y-1">
                          <Progress value={pct} className="h-1.5" />
                          <p className="text-xs text-gray-500">
                            {application.job?.externalUrl ? 'Status self-reported' : 'Status updated by employer'}
                          </p>
                        </div>
                      ) : null;
                    })()}
                    {/* Self-service status update for external jobs (hidden while agent is still queued/submitting) */}
                    {application.job?.externalUrl && application.status !== 'submitting' && application.status !== 'queued' && (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-600">Update Status:</span>
                        <Select
                          value={application.status === 'applied' ? 'submitted' : application.status}
                          onValueChange={(newStatus) => updateStatusMutation.mutate({ applicationId: application.id, status: newStatus })}
                        >
                          <SelectTrigger className="w-[180px] h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="submitted">Submitted</SelectItem>
                            <SelectItem value="screening">In Progress</SelectItem>
                            <SelectItem value="interview_scheduled">Interview</SelectItem>
                            <SelectItem value="offer">Offer</SelectItem>
                            <SelectItem value="rejected">Not Selected</SelectItem>
                            <SelectItem value="withdrawn">Withdrawn</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Timeline Info */}
                    <div className="flex items-center justify-between text-sm text-gray-600">
                      <div className="flex items-center gap-4">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          Applied {application.appliedAt && !isNaN(new Date(application.appliedAt).getTime())
                            ? formatDistanceToNow(new Date(application.appliedAt), { addSuffix: true })
                            : 'recently'}
                        </span>
                        {application.viewedByEmployerAt && !isNaN(new Date(application.viewedByEmployerAt).getTime()) && (
                          <span className="flex items-center gap-1">
                            <Eye className="h-4 w-4" />
                            Viewed {formatDistanceToNow(new Date(application.viewedByEmployerAt), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {/* Take Exam button: internal jobs with exam, submitted/applied status */}
                        {!application.job?.externalUrl && application.job?.hasExam && ['applied', 'submitted'].includes(application.status) && (
                          <Button variant="outline" size="sm" className="border-purple-300 text-purple-700 hover:bg-purple-50 dark:border-purple-700 dark:text-purple-400" onClick={() => setLocation(`/exam/${application.job?.id}`)}>
                            <FileText className="h-4 w-4 mr-1" />
                            Take Exam
                          </Button>
                        )}
                        {/* Message button: show whenever a chat room exists for this application */}
                        {application.chatRoomId && (
                          <Button variant="outline" size="sm" onClick={() => setLocation(`/chat/${application.chatRoomId}`)}>
                            <MessageSquare className="h-4 w-4 mr-1" />
                            Open Chat
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (application.job?.externalUrl) {
                              window.open(application.job.externalUrl, '_blank');
                            } else {
                              setLocation(`/candidate-dashboard?tab=jobs&job=${application.job?.id || ''}`);
                            }
                          }}
                        >
                          <ExternalLink className="h-4 w-4 mr-1" />
                          View Job
                        </Button>
                      </div>
                    </div>

                    {/* Salary Range */}
                    {(application.job?.salaryMin || application.job?.salaryMax) && (
                      <div className="text-sm text-gray-600">
                        Salary: ${application.job?.salaryMin?.toLocaleString() || 'N/A'} - ${application.job?.salaryMax?.toLocaleString() || 'N/A'}
                      </div>
                    )}


                    {/* Interview Info */}
                    {application.status === 'interview_scheduled' && application.interviewDate && (
                      <div className="bg-purple-50 dark:bg-purple-900/20 p-3 rounded-lg">
                        <div className="flex items-center gap-2 text-purple-700 dark:text-purple-300">
                          <Calendar className="h-4 w-4" />
                          <span className="font-medium">Interview scheduled</span>
                        </div>
                        <div className="text-sm text-purple-600 dark:text-purple-400 mt-1">
                          {new Date(application.interviewDate).toLocaleDateString()} at{' '}
                          {new Date(application.interviewDate).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Closed Applications */}
      {closedApplications.length > 0 && (
        <div>
          <Separator />
          <div className="flex items-center justify-between mb-4 mt-6">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              Past Applications ({closedApplications.length})
            </h3>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-gray-500 hover:text-red-600">
                  <Trash2 className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear past applications?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes your {closedApplications.length} past
                    (not selected / withdrawn) application{closedApplications.length === 1 ? '' : 's'}.
                    Active applications are not affected. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => clearClosedMutation.mutate()}
                    disabled={clearClosedMutation.isPending}
                    className="bg-red-600 hover:bg-red-700"
                  >
                    {clearClosedMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : null}
                    Clear
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          <div className="space-y-3">
            {closedApplications.map((application) => (
              <Card key={application.id} className="opacity-75">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">{application.job?.title || 'Unknown Job'}</h4>
                      <p className="text-sm text-gray-600">{application.job?.company || 'Unknown Company'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {getStatusBadge(application.status)}
                      <ChevronRight className="h-4 w-4 text-gray-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}