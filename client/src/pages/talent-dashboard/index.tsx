import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useSupabaseClient } from "@supabase/auth-helpers-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

import { getErrorMessage } from "@/lib/dashboard-utils";
import RealTimeNotifications from "@/components/real-time-notifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Users, Briefcase, TrendingUp, Settings, LogOut, Loader2, BarChart3
} from "lucide-react";
import SmartLogo from "@/components/smart-logo";
import JobPostingWizard from "@/components/job-posting-wizard";
import TalentOwnerProfileCompletion from "@/components/talent-owner-profile-completion";
import { ThemeToggleButton } from "@/components/theme-toggle-button";

import type { JobPosting, DashboardStats, TabName } from "./types";
import OverviewTab from "./OverviewTab";
import JobsTab from "./JobsTab";
import CandidatesTab from "./CandidatesTab";
import AnalyticsTab from "./AnalyticsTab";

const TAB_CONFIG: { id: TabName; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: TrendingUp },
  { id: 'jobs', label: 'Jobs', icon: Briefcase },
  { id: 'candidates', label: 'Candidates', icon: Users },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
];

export default function TalentDashboard() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const supabase = useSupabaseClient();
  const [, setLocation] = useLocation();

  const getTabFromUrl = (): TabName => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab && ['overview', 'jobs', 'candidates', 'analytics'].includes(tab)) {
      return tab as TabName;
    }
    return 'overview';
  };

  const getActionFromUrl = (): string | null => {
    const params = new URLSearchParams(window.location.search);
    return params.get('action');
  };

  const [activeTab, setActiveTabState] = useState<TabName>(getTabFromUrl);

  const setActiveTab = (tab: TabName) => {
    setActiveTabState(tab);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState({}, '', url.toString());
  };

  useEffect(() => {
    const handlePopState = () => setActiveTabState(getTabFromUrl());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const action = getActionFromUrl();
    if (action === 'new') {
      setShowJobWizard(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('action');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const [showJobWizard, setShowJobWizard] = useState(false);
  const [showJobDialog, setShowJobDialog] = useState(false);
  const [selectedJob, setSelectedJob] = useState<JobPosting | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [expandedApplicantId, setExpandedApplicantId] = useState<number | null>(null);
  const [scheduleInterviewOpen, setScheduleInterviewOpen] = useState(false);
  const [scheduleApplicant, setScheduleApplicant] = useState<{ applicationId: number; candidateId: string; name: string } | null>(null);
  const [interviewForm, setInterviewForm] = useState({ scheduledAt: '', duration: 60, platform: 'video', meetingLink: '', notes: '' });
  const [screeningQuestions, setScreeningQuestions] = useState<{ [key: number]: string[] }>();
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [jobToDelete, setJobToDelete] = useState<JobPosting | null>(null);
  const [jobForm, setJobForm] = useState({
    title: "",
    company: "",
    description: "",
    requirements: [] as string[],
    skills: [] as string[],
    location: "",
    salaryMin: "",
    salaryMax: "",
    workType: "remote" as "remote" | "hybrid" | "onsite",
    industry: "",
    urgency: "medium" as "low" | "medium" | "high",
    benefits: [] as string[],
    experienceLevel: "",
    department: "",
    isRemoteFriendly: true,
    applicationDeadline: "",
    contactEmail: "",
    companySize: "",
    companyDescription: ""
  });

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) setLocation("/auth");
  }, [isAuthenticated, isLoading, setLocation]);

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ['/api/recruiter/stats'],
    retry: false,
    enabled: !!user,
  });

  const { data: jobs = [], isLoading: jobsLoading, refetch: refetchJobs } = useQuery<JobPosting[]>({
    queryKey: ['/api/talent-owner/jobs'],
    retry: false,
    enabled: !!user,
  });

  const { data: applicants = [], isLoading: applicantsLoading } = useQuery<any[]>({
    queryKey: ['/api/jobs', selectedJob?.id, 'applicants'],
    enabled: !!selectedJob,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/jobs/${selectedJob!.id}/applicants`);
      if (!res.ok) throw new Error('Failed to fetch applicants');
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const { data: allApplicants = [] } = useQuery<any[]>({
    queryKey: ['/api/talent-owner/all-applicants'],
    enabled: !!user,
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/talent-owner/all-applicants');
      if (!res.ok) throw new Error('Failed to fetch all applicants');
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ applicationId, status }: { applicationId: number, status: string }) => {
      return await apiRequest('PUT', `/api/applications/${applicationId}/status`, { status });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Applicant status updated!" });
      queryClient.invalidateQueries({ queryKey: ['/api/jobs', selectedJob?.id, 'applicants'] });
    },
    onError: (error) => {
      toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
    },
  });

  const scheduleInterviewMutation = useMutation({
    mutationFn: async (data: { candidateId: string; jobId: number; applicationId: number; scheduledAt: string; duration: number; platform: string; meetingLink: string; notes: string }) => {
      const res = await apiRequest('POST', '/api/interviews/schedule', data);
      if (!res.ok) { const err = await res.json().catch(() => ({ message: 'Failed to schedule interview' })); throw new Error(err.message); }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Interview scheduled!", description: "The candidate has been notified." });
      setScheduleInterviewOpen(false);
      setInterviewForm({ scheduledAt: '', duration: 60, platform: 'video', meetingLink: '', notes: '' });
      queryClient.invalidateQueries({ queryKey: ['/api/jobs', selectedJob?.id, 'applicants'] });
    },
    onError: (error) => {
      toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
    },
  });

  const createJobMutation = useMutation({
    mutationFn: async (jobData: any) => {
      return await apiRequest('POST', '/api/jobs', jobData);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Job posted successfully!" });
      setShowJobDialog(false);
      setJobForm({
        title: "", company: "", description: "", requirements: [], skills: [],
        location: "", salaryMin: "", salaryMax: "", workType: "remote",
        industry: "", urgency: "medium", benefits: [], experienceLevel: "",
        department: "", isRemoteFriendly: true, applicationDeadline: "",
        contactEmail: "", companySize: "", companyDescription: ""
      });
      queryClient.invalidateQueries({ queryKey: ['/api/talent-owner/jobs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/recruiter/stats'] });
    },
    onError: (error) => {
      toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
    },
  });

  const deleteJobMutation = useMutation({
    mutationFn: async (jobId: number) => {
      return await apiRequest('DELETE', `/api/jobs/${jobId}`, {});
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Job deleted successfully!" });
      queryClient.invalidateQueries({ queryKey: ['/api/talent-owner/jobs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/recruiter/stats'] });
    },
    onError: (error) => {
      toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
    }
  });

  const updateJobMutation = useMutation({
    mutationFn: async ({ jobId, data }: { jobId: number, data: any }) => {
      return await apiRequest('PUT', `/api/jobs/${jobId}`, data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Job updated successfully!" });
      setShowJobDialog(false);
      setSelectedJob(null);
      queryClient.invalidateQueries({ queryKey: ['/api/talent-owner/jobs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/recruiter/stats'] });
    },
    onError: (error) => {
      toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
    }
  });

  const generateQuestionsMutation = useMutation({
    mutationFn: async ({ jobId, candidateId }: { jobId: number, candidateId: string }) => {
      const response = await apiRequest('POST', '/api/ai/screening-questions', { jobId, candidateId });
      return await response.json();
    },
    onSuccess: (data, variables) => {
      setScreeningQuestions(prev => ({ ...prev, [variables.candidateId]: data.questions }));
      toast({ title: "AI Questions Generated", description: "Suggested screening questions are now available." });
    },
    onError: (error: any) => {
      toast({ title: "Generation Failed", description: error.message, variant: "destructive" });
    },
  });

  const startChatMutation = useMutation({
    mutationFn: async ({ jobId, candidateId }: { jobId: number, candidateId: string }) => {
      const response = await apiRequest('POST', '/api/chat/rooms/create', { jobId, candidateId });
      return await response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Chat Started", description: "Opening chat room..." });
      setLocation(`/chat/${data.id}`);
    },
    onError: (error: any) => {
      toast({ title: "Chat Failed", description: error.message || "Failed to start chat", variant: "destructive" });
    },
  });

  const handleUpdateStatus = (applicationId: number, status: string) => {
    updateStatusMutation.mutate({ applicationId, status });
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast({ title: "Error signing out", description: error.message, variant: "destructive" });
    } else {
      setLocation("/auth");
    }
  };

  const filteredJobs = jobs.filter(job => {
    const matchesSearch = job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.company.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = filterStatus === "all" || job.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const filteredCandidates = applicants.filter(applicant => {
    const candidate = applicant.candidate;
    const matchesSearch = searchQuery === "" ||
      candidate.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      candidate.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      candidate.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = filterStatus === "all" || applicant.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const totalRanked = applicants.filter((a: any) => a.examRanking != null).length;
  const maxChat = selectedJob?.maxChatCandidates || 5;

  const applicantsWithSeparator: any[] = (() => {
    if (!selectedJob?.hasExam) return filteredCandidates;
    const qualified = filteredCandidates.filter((a: any) => a.qualifiedForChat);
    const below = filteredCandidates.filter((a: any) => !a.qualifiedForChat);
    if (below.length === 0) return qualified;
    return [...qualified, { _separator: true }, ...below];
  })();

  const displayName = (user as any)?.firstName || user?.email?.split('@')[0] || 'User';
  const avatarInitial = displayName[0]?.toUpperCase() || 'U';

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Sticky Header */}
      <header className="bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-200 dark:border-gray-800 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Left: Logo + breadcrumb */}
            <div className="flex items-center gap-3">
              <SmartLogo size={28} showText={false} />
              <span className="hidden sm:block text-xs text-gray-400 dark:text-gray-500 font-medium tracking-wide uppercase">Recruiter</span>

              {/* Desktop tab nav */}
              <nav className="hidden lg:flex items-center gap-1 ml-4">
                {TAB_CONFIG.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                      activeTab === id
                        ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </nav>
            </div>

            {/* Right: actions */}
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setShowJobWizard(true)}
                size="sm"
                className="hidden sm:flex bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Post Job
              </Button>

              <ThemeToggleButton />
              <RealTimeNotifications />

              {/* Avatar dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2">
                    <div className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white text-sm font-semibold">
                      {avatarInitial}
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-52" align="end" forceMount>
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{displayName}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setShowProfileSettings(true)}>
                    <Settings className="mr-2 h-4 w-4" />
                    Profile Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleSignOut} className="text-red-600 dark:text-red-400">
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Mobile tab nav */}
          <div className="lg:hidden flex items-center gap-1 pb-2 overflow-x-auto">
            {TAB_CONFIG.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-all shrink-0 ${
                  activeTab === id
                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'overview' && (
          <OverviewTab
            user={user}
            stats={stats}
            statsLoading={statsLoading}
            jobs={jobs}
            jobsLoading={jobsLoading}
            setActiveTab={setActiveTab}
            setShowJobWizard={setShowJobWizard}
          />
        )}
        {activeTab === 'jobs' && (
          <JobsTab
            jobs={jobs}
            jobsLoading={jobsLoading}
            filteredJobs={filteredJobs}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            filterStatus={filterStatus}
            setFilterStatus={setFilterStatus}
            setSelectedJob={setSelectedJob}
            setJobForm={setJobForm}
            setShowJobDialog={setShowJobDialog}
            setShowJobWizard={setShowJobWizard}
            setJobToDelete={setJobToDelete}
            setActiveTab={setActiveTab}
          />
        )}
        {activeTab === 'candidates' && (
          <CandidatesTab
            selectedJob={selectedJob}
            applicants={applicants}
            applicantsLoading={applicantsLoading}
            applicantsWithSeparator={applicantsWithSeparator}
            totalRanked={totalRanked}
            maxChat={maxChat}
            expandedApplicantId={expandedApplicantId}
            setExpandedApplicantId={setExpandedApplicantId}
            screeningQuestions={screeningQuestions}
            handleUpdateStatus={handleUpdateStatus}
            startChatMutation={startChatMutation}
            generateQuestionsMutation={generateQuestionsMutation}
            setScheduleApplicant={setScheduleApplicant}
            setScheduleInterviewOpen={setScheduleInterviewOpen}
          />
        )}
        {activeTab === 'analytics' && (
          <AnalyticsTab
            jobs={jobs}
            allApplicants={allApplicants}
          />
        )}
      </main>

      {/* Job Posting Wizard */}
      {showJobWizard && (
        <Dialog open={showJobWizard} onOpenChange={setShowJobWizard}>
          <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto p-0">
            <JobPostingWizard
              isSubmitting={createJobMutation.isPending}
              onSubmit={async (jobData) => {
                try {
                  const jobPayload = {
                    title: jobData.title,
                    company: jobData.company,
                    description: jobData.description,
                    requirements: jobData.requirements,
                    skills: jobData.skills,
                    location: jobData.location,
                    workType: jobData.workType,
                    salaryMin: jobData.salaryMin,
                    salaryMax: jobData.salaryMax,
                    externalUrl: jobData.externalUrl || null,
                    expiresAt: jobData.expiresAt ? new Date(jobData.expiresAt) : null,
                    hasExam: jobData.enableFiltering,
                    exam: jobData.enableFiltering ? {
                      questions: jobData.filteringExam?.questions || [],
                      timeLimit: jobData.filteringExam?.timeLimit || 30,
                      passingScore: jobData.filteringExam?.passingScore || 70
                    } : null
                  };

                  await createJobMutation.mutateAsync(jobPayload);
                  toast({ title: "Success", description: "Job posted successfully! Candidates will be matched shortly." });
                  setShowJobWizard(false);
                } catch (error: any) {
                  console.error('[TalentDashboard] Failed to create job:', error);
                  let errorDescription = 'Something went wrong. Please try again.';
                  try {
                    if (error?.response) {
                      const errorData = await error.response.json();
                      if (errorData.errors) {
                        errorDescription = Object.entries(errorData.errors)
                          .map(([field, msgs]) => `${field}: ${(msgs as string[]).join(', ')}`)
                          .join('; ') || errorData.message || errorDescription;
                      } else {
                        errorDescription = errorData.message || errorDescription;
                      }
                    } else if (error?.message) {
                      if (error.message.includes('401')) errorDescription = 'Please log in again';
                      else if (error.message.includes('400')) errorDescription = 'Please check all required fields are filled correctly';
                    }
                  } catch { /* ignore */ }
                  toast({ title: "Failed to create job", description: errorDescription, variant: "destructive" });
                }
              }}
              onCancel={() => setShowJobWizard(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Job Edit Dialog */}
      {showJobDialog && selectedJob && (
        <Dialog open={showJobDialog} onOpenChange={(open) => {
          if (!open) { setShowJobDialog(false); setSelectedJob(null); }
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Job Posting</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Job Title</label>
                  <Input value={jobForm.title} onChange={(e) => setJobForm(prev => ({ ...prev, title: e.target.value }))} placeholder="e.g. Senior Software Engineer" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Company</label>
                  <Input value={jobForm.company} onChange={(e) => setJobForm(prev => ({ ...prev, company: e.target.value }))} placeholder="Company name" />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <Textarea value={jobForm.description} onChange={(e) => setJobForm(prev => ({ ...prev, description: e.target.value }))} placeholder="Describe the role and responsibilities..." rows={4} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Location</label>
                  <Input value={jobForm.location} onChange={(e) => setJobForm(prev => ({ ...prev, location: e.target.value }))} placeholder="e.g. New York, NY" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Work Type</label>
                  <Select value={jobForm.workType} onValueChange={(value) => setJobForm(prev => ({ ...prev, workType: value as "remote" | "hybrid" | "onsite" }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="remote">Remote</SelectItem>
                      <SelectItem value="hybrid">Hybrid</SelectItem>
                      <SelectItem value="onsite">On-site</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Min Salary</label>
                  <Input type="number" value={jobForm.salaryMin} onChange={(e) => setJobForm(prev => ({ ...prev, salaryMin: e.target.value }))} placeholder="e.g. 80000" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Max Salary</label>
                  <Input type="number" value={jobForm.salaryMax} onChange={(e) => setJobForm(prev => ({ ...prev, salaryMax: e.target.value }))} placeholder="e.g. 120000" />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Required Skills (comma separated)</label>
                <Input value={jobForm.skills.join(', ')} onChange={(e) => setJobForm(prev => ({ ...prev, skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder="e.g. React, TypeScript, Node.js" />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Requirements (comma separated)</label>
                <Textarea value={jobForm.requirements.join(', ')} onChange={(e) => setJobForm(prev => ({ ...prev, requirements: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder="e.g. 5+ years experience, Bachelor's degree" rows={2} />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t">
              <Button variant="outline" onClick={() => { setShowJobDialog(false); setSelectedJob(null); }}>Cancel</Button>
              <Button
                onClick={() => {
                  if (selectedJob) {
                    updateJobMutation.mutate({
                      jobId: selectedJob.id,
                      data: {
                        title: jobForm.title,
                        company: jobForm.company,
                        description: jobForm.description,
                        requirements: jobForm.requirements,
                        skills: jobForm.skills,
                        location: jobForm.location,
                        salaryMin: jobForm.salaryMin ? parseInt(jobForm.salaryMin) : undefined,
                        salaryMax: jobForm.salaryMax ? parseInt(jobForm.salaryMax) : undefined,
                        workType: jobForm.workType
                      }
                    });
                  }
                }}
                disabled={updateJobMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {updateJobMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
                ) : 'Save Changes'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Profile Settings */}
      {showProfileSettings && (
        <TalentOwnerProfileCompletion
          user={user}
          onComplete={() => {
            setShowProfileSettings(false);
            queryClient.invalidateQueries({ queryKey: ['/api/session'] });
            toast({ title: "Profile Updated", description: "Your profile has been successfully updated." });
            window.location.reload();
          }}
          onCancel={() => setShowProfileSettings(false)}
        />
      )}

      {/* Delete Job Confirmation */}
      <AlertDialog open={!!jobToDelete} onOpenChange={(open) => !open && setJobToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Job Posting</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{jobToDelete?.title}"? This action cannot be undone.
              All applications and data associated with this job will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (jobToDelete) { deleteJobMutation.mutate(jobToDelete.id); setJobToDelete(null); }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Schedule Interview Dialog */}
      <Dialog open={scheduleInterviewOpen} onOpenChange={setScheduleInterviewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule Interview{scheduleApplicant?.name ? `: ${scheduleApplicant.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Date &amp; Time *</label>
              <Input
                type="datetime-local"
                value={interviewForm.scheduledAt}
                onChange={(e) => setInterviewForm(prev => ({ ...prev, scheduledAt: e.target.value }))}
                min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Duration (minutes)</label>
              <Select value={String(interviewForm.duration)} onValueChange={(v) => setInterviewForm(prev => ({ ...prev, duration: Number(v) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 min</SelectItem>
                  <SelectItem value="45">45 min</SelectItem>
                  <SelectItem value="60">60 min</SelectItem>
                  <SelectItem value="90">90 min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Platform</label>
              <Select value={interviewForm.platform} onValueChange={(v) => setInterviewForm(prev => ({ ...prev, platform: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="video">Video Call</SelectItem>
                  <SelectItem value="phone">Phone</SelectItem>
                  <SelectItem value="onsite">On-site</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Meeting Link (optional)</label>
              <Input type="url" placeholder="https://meet.google.com/..." value={interviewForm.meetingLink} onChange={(e) => setInterviewForm(prev => ({ ...prev, meetingLink: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium">Notes (optional)</label>
              <Textarea placeholder="Preparation notes for the candidate..." value={interviewForm.notes} onChange={(e) => setInterviewForm(prev => ({ ...prev, notes: e.target.value }))} rows={3} />
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={!interviewForm.scheduledAt || scheduleInterviewMutation.isPending || !selectedJob || !scheduleApplicant}
                onClick={() => {
                  if (!selectedJob || !scheduleApplicant) return;
                  scheduleInterviewMutation.mutate({
                    candidateId: scheduleApplicant.candidateId,
                    jobId: selectedJob.id,
                    applicationId: scheduleApplicant.applicationId,
                    scheduledAt: interviewForm.scheduledAt,
                    duration: interviewForm.duration,
                    platform: interviewForm.platform,
                    meetingLink: interviewForm.meetingLink,
                    notes: interviewForm.notes,
                  });
                }}
              >
                {scheduleInterviewMutation.isPending ? 'Scheduling...' : 'Confirm Interview'}
              </Button>
              <Button variant="outline" onClick={() => setScheduleInterviewOpen(false)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
