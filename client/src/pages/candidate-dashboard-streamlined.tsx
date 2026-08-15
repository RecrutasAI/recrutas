import { useEffect, useState, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { useSupabaseClient } from "@supabase/auth-helpers-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, fetchProfileWithCache } from "@/lib/queryClient";
import { getCachedProfile } from "@/utils/storage.utils";
import { isUnauthorizedError } from "@/lib/authUtils";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Bell,
  User,
  Upload,
  Search,
  Briefcase,
  TrendingUp,
  Star,
  CheckCircle,
  AlertCircle,
  FileText,
  Target,
  Zap,
  MessageCircle,
  Eye,
  ExternalLink,
  Settings,
  LogOut,
  Bookmark,
  Shield,
  Palette,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import SmartLogo from "@/components/smart-logo";
import AIJobFeed from "@/components/ai-job-feed";
import ProfileWizard from "@/components/profile-wizard";
import ApplicationTracker from "@/components/application-tracker";
import RealTimeNotifications from "@/components/real-time-notifications";
import JobMatchesModal from "@/components/job-matches-modal";
import { ThemeToggleButton } from "@/components/theme-toggle-button";
import { ProfileCompletionModal } from "@/components/profile-completion-modal";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/components/theme-provider";

interface DashboardStats {
  newMatches: number;
  profileViews: number;
  activeChats: number;
  applicationsPending: number;
  applicationsRejected: number;
  applicationsAccepted: number;
}

interface Activity {
  id: number;
  type: string;
  description: string;
  createdAt: string;
  metadata?: any;
}

interface Application {
  id: number;
  status: string;
  jobTitle: string;
  company: string;
  appliedAt: string;
  updatedAt: string;
}

export default function CandidateStreamlinedDashboard() {
  const [, setLocation] = useLocation();
  const { user, isAuthenticated, isLoading } = useAuth();
  const supabase = useSupabaseClient();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'jobs' | 'saved' | 'applications' | 'profile' | 'agent'>('jobs');
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setLocation("/auth");
  };

  // Redirect to login if not authenticated
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setLocation("/auth");
    }
  }, [isAuthenticated, isLoading, setLocation]);

  // Track job feed views (once per tab switch)
  const jobFeedTracked = useRef(false);
  useEffect(() => {
    if (activeTab === 'jobs' && !jobFeedTracked.current) {
      jobFeedTracked.current = true;
      track('job_feed_viewed');
    }
    if (activeTab !== 'jobs') {
      jobFeedTracked.current = false;
    }
  }, [activeTab]);

  // Fetch candidate stats
  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ['/api/candidate/stats'],
    queryFn: async () => {
      const response = await apiRequest("GET", '/api/candidate/stats');
      return response.json();
    },
    enabled: !!user,
    retry: false,
    meta: {
      onError: (error: Error) => {
        if (isUnauthorizedError(error)) {
          setLocation("/api/login");
        }
      },
    },
  });

  // Fetch profile
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['/api/candidate/profile'],
    queryFn: fetchProfileWithCache,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    initialData: getCachedProfile,  // Use cached data while fetching
    staleTime: 1000 * 60 * 5,       // Consider fresh for 5 minutes
  });

  // Fetch recent activity
  const { data: activities } = useQuery<Activity[]>({
    queryKey: ['/api/candidate/activity'],
    queryFn: async () => {
      const response = await apiRequest("GET", '/api/candidate/activity');
      return response.json();
    },
    enabled: !!user,
    retry: false,
  });

  // Fetch applications
  const { data: applications } = useQuery<Application[]>({
    queryKey: ['/api/candidate/applications'],
    queryFn: async () => {
      const response = await apiRequest("GET", '/api/candidate/applications');
      if (!response.ok) { throw new Error(`${response.status}`); }
      return response.json();
    },
    enabled: !!user,
    retry: false,
  });



  const profileCompletion = useMemo(() => {
    if (!profile) {return 0;}
    let completed = 0;
    const total = 6;

    // Resume counts as 1 factor (most important)
    if ((profile as any).resumeUrl) {completed++;}
    if ((profile as any).skills && (profile as any).skills.length > 0) {completed++;}
    if ((profile as any).experience) {completed++;}
    if ((profile as any).location) {completed++;}
    if ((profile as any).workType) {completed++;}
    if ((profile as any).salaryMin && (profile as any).salaryMax) {completed++;}

    return Math.round((completed / total) * 100);
  }, [profile]);

  const hasResume = (profile as any)?.resumeUrl || false;
  const resumeProcessingStatus = (profile as any)?.resumeProcessingStatus || 'idle';
  const isResumeProcessing = resumeProcessingStatus === 'processing';

  // Poll for resume processing status updates when processing (max 5 minutes)
  useEffect(() => {
    if (isResumeProcessing) {
      const pollStartTime = Date.now();
      const MAX_POLL_DURATION_MS = 5 * 60 * 1000;

      const pollInterval = setInterval(async () => {
        if (Date.now() - pollStartTime > MAX_POLL_DURATION_MS) {
          clearInterval(pollInterval);
          toast({
            title: 'Resume Processing Timeout',
            description: 'Resume processing is taking longer than expected. Please try uploading again or add your skills manually.',
            variant: 'destructive',
          });
          queryClient.invalidateQueries({ queryKey: ['/api/candidate/profile'] });
          return;
        }

        try {
          // Same unwrapping trap as the guided-setup poll: the endpoint answers
          // `{ exists, profile }`. Reading status off the raw body gave undefined,
          // which is `!== 'processing'`, so this fired on the FIRST tick and told
          // the user "there was an issue processing your resume" while it was
          // still parsing normally.
          const data = await fetchProfileWithCache();
          if (data?.resumeProcessingStatus && data.resumeProcessingStatus !== 'processing') {
            clearInterval(pollInterval);
            queryClient.invalidateQueries({ queryKey: ['/api/candidate/profile'] });
            queryClient.invalidateQueries({ queryKey: ['/api/ai-matches'] });
            queryClient.invalidateQueries({ queryKey: ['/api/candidate/stats'] });
            toast({
              title: 'Resume Processing Complete',
              description: data.resumeProcessingStatus === 'completed'
                ? 'Your skills have been extracted! Check your job feed for updated matches.'
                : 'There was an issue processing your resume. You can add skills manually.',
            });
          }
        } catch (error) {
          console.error('Error polling resume status:', error);
        }
      }, 5000);

      return () => clearInterval(pollInterval);
    }
  }, [isResumeProcessing, queryClient, toast]);

  const firstName = (profile as any)?.firstName || (user as any)?.firstName || null;
  const displayName = firstName || user?.email?.split('@')[0] || 'there';
  const isReturningUser = (applications?.length ?? 0) > 0 || hasResume;
  const avatarInitial = ((user as any)?.firstName?.[0] || user?.email?.[0] || 'U').toUpperCase();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  const tabItems = [
    { id: 'jobs' as const, label: 'Jobs', icon: Search, badge: hasResume && (stats?.newMatches ?? 0) > 0 && activeTab !== 'jobs' ? stats!.newMatches : null },
    { id: 'saved' as const, label: 'Saved', icon: Bookmark, badge: null },
    { id: 'applications' as const, label: 'Applications', icon: Briefcase, badge: (stats?.applicationsPending ?? 0) > 0 && activeTab !== 'applications' ? stats!.applicationsPending : null },
    { id: 'profile' as const, label: 'Profile', icon: User, badge: null },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Sticky Header */}
      <header className="bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-200 dark:border-gray-800 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Logo + breadcrumb */}
            <div className="flex items-center gap-3">
              <SmartLogo size={28} showText={false} />
              <span className="hidden sm:block text-xs text-gray-400 dark:text-gray-500 font-medium tracking-wide uppercase">Candidate</span>
            </div>

            {/* Desktop tab nav */}
            <nav className="hidden md:flex items-center gap-1">
              {tabItems.map(({ id, label, icon: Icon, badge }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    activeTab === id
                      ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                  {badge !== null && badge !== undefined && (
                    <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {badge}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            {/* Right controls */}
            <div className="flex items-center gap-2">
              <ThemeToggleButton />
              <RealTimeNotifications onNavigate={(tab, path) => {
                if (path) {setLocation(path);}
                else if (tab) {setActiveTab(tab as any);}
              }} />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 rounded-full">
                    <div className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white text-sm font-semibold">
                      {avatarInitial}
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56 rounded-xl p-1.5 shadow-lg border-slate-200 dark:border-slate-700" align="end" sideOffset={8} forceMount>
                  <DropdownMenuLabel className="font-normal px-3 py-2">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {(user as any)?.firstName && (user as any)?.lastName
                          ? `${(user as any).firstName} ${(user as any).lastName}`
                          : displayName}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{user?.email || 'Candidate'}</p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="mx-1" />
                  <DropdownMenuItem onClick={() => { setActiveTab('profile'); setIsEditingProfile(true); }} className="rounded-lg px-3 py-2 cursor-pointer">
                    <User className="mr-2 h-4 w-4" />
                    Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSettingsModalOpen(true)} className="rounded-lg px-3 py-2 cursor-pointer">
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mx-1" />
                  <DropdownMenuItem onClick={handleSignOut} className="rounded-lg px-3 py-2 cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/30">
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Mobile tab nav */}
          <div className="md:hidden flex items-center gap-1 pb-2 overflow-x-auto">
            {tabItems.map(({ id, label, icon: Icon, badge }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap shrink-0 transition-all ${
                  activeTab === id
                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {badge !== null && badge !== undefined && (
                  <span className="ml-1 h-4 min-w-4 px-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        {/* Welcome + profile strip (only on jobs tab, only once resume uploaded) */}
        {activeTab === 'jobs' && hasResume && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                {isReturningUser ? `Welcome back, ${displayName}` : `Welcome, ${displayName}`}
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Here's what's happening with your job search today.
              </p>
            </div>
            {/* Profile completion mini-bar - only show if not complete */}
            {profile && profileCompletion < 100 && (
              <div
                className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 cursor-pointer hover:border-gray-300 dark:hover:border-gray-700 transition-colors shrink-0"
                onClick={() => { setActiveTab('profile'); setIsEditingProfile(true); }}
              >
                <div className="h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center text-sm font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                  {avatarInitial}
                </div>
                <div className="min-w-[120px]">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Profile</span>
                    <span className={`text-xs font-bold ${profileCompletion === 100 ? 'text-emerald-600' : profileCompletion >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
                      {profileCompletion}%
                    </span>
                  </div>
                  <Progress value={profileCompletion} className="h-1.5 w-full" />
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              </div>
            )}
          </div>
        )}


        {/* TODO: Phase 3 — stats row (Applications, Recruiter Views, Active Chats, New Matches) */}

        {/* Resume Processing Status Banners */}
        {isResumeProcessing && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-amber-100 dark:bg-amber-900 flex items-center justify-center shrink-0">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-amber-600 dark:border-amber-400 border-t-transparent" />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Analyzing your resume</p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">AI is extracting your skills and experience. You'll be notified when complete.</p>
              </div>
            </div>
          </div>
        )}

        {resumeProcessingStatus === 'completed' && (profile as any)?.parsedAt && (
          new Date((profile as any).parsedAt).getTime() > Date.now() - 60000 && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center shrink-0">
                  <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">Resume processed successfully</p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-0.5">Your skills have been extracted. Check your job feed for updated matches!</p>
                </div>
              </div>
            </div>
          )
        )}

        {resumeProcessingStatus === 'failed' && (
          <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-4">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-red-100 dark:bg-red-900 flex items-center justify-center shrink-0">
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-red-900 dark:text-red-100">Resume processing failed</p>
                <p className="text-xs text-red-700 dark:text-red-300 mt-0.5">We couldn't extract your information. Try uploading a different file or add skills manually.</p>
              </div>
            </div>
          </div>
        )}


        {/* Tab Content */}
        {activeTab === 'jobs' && (
          <div className="relative">
            {isResumeProcessing && (
              <div className="absolute inset-0 z-10 flex items-start justify-center pt-24 bg-white/70 dark:bg-gray-900/70 rounded-xl backdrop-blur-sm">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent mx-auto mb-4" />
                  <p className="text-sm font-semibold text-gray-800 dark:text-white">Finding your matches...</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Hang on while we scan your resume</p>
                </div>
              </div>
            )}
            
            {/* Only show AI-matched jobs if resume is uploaded */}
            {profileLoading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
                <p className="text-sm text-gray-500 dark:text-gray-400">Loading your profile...</p>
              </div>
            ) : hasResume ? (
              <AIJobFeed onUploadClick={() => { setActiveTab('profile'); setIsEditingProfile(true); }} />
            ) : (
              <div className="max-w-lg mx-auto py-10">
                {/* Icon */}
                <div className="h-14 w-14 rounded-2xl bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center mx-auto mb-6">
                  <Sparkles className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
                </div>

                {/* Headline */}
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white text-center mb-2">
                  See your job matches
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-8">
                  Upload your resume once — our AI extracts your skills and ranks jobs by how likely you are to get them.
                </p>

                {/* What happens next */}
                <div className="space-y-3 mb-8">
                  {[
                    { icon: FileText, label: 'Skills & experience extracted automatically', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/40' },
                    { icon: Target,   label: 'Jobs ranked by your actual fit, not keywords',  color: 'text-blue-600 dark:text-blue-400',    bg: 'bg-blue-50 dark:bg-blue-900/40' },
                    { icon: Zap,      label: 'Apply to internal roles with guaranteed feedback', color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/40' },
                  ].map(({ icon: Icon, label, color, bg }) => (
                    <div key={label} className="flex items-center gap-3">
                      <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${bg}`}>
                        <Icon className={`h-4 w-4 ${color}`} />
                      </div>
                      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
                    </div>
                  ))}
                </div>

                {/* Single CTA */}
                <Button
                  onClick={() => { setActiveTab('profile'); setIsEditingProfile(true); }}
                  size="lg"
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold h-11"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Resume
                </Button>
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-3">
                  PDF or Word · Under 5 MB · Takes about 30 seconds
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'saved' && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Saved Jobs</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Jobs you've bookmarked for later</p>
            </div>
            <SavedJobsList />
          </div>
        )}

        {activeTab === 'applications' && (
          <div>
            {applications && applications.length === 0 ? (
              <div className="text-center py-16">
                <div className="h-14 w-14 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
                  <Briefcase className="h-7 w-7 text-gray-400" />
                </div>
                <p className="text-base font-semibold text-gray-700 dark:text-gray-300 mb-1">No applications yet</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Start applying to jobs and track every status here in real time.</p>
                <Button onClick={() => setActiveTab('jobs')} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  <Search className="h-4 w-4 mr-2" />
                  Browse Jobs
                </Button>
              </div>
            ) : (
              <ApplicationTracker />
            )}
          </div>
        )}

        {activeTab === 'profile' && (
          <div className="max-w-3xl space-y-5">
            {/* Show different content based on profile completion */}
            {profileCompletion === 100 && !isEditingProfile ? (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-5 text-center">
                <CheckCircle className="h-12 w-12 text-emerald-600 mx-auto mb-3" />
                <h3 className="text-lg font-semibold text-emerald-800 dark:text-emerald-200">
                  Your profile is complete!
                </h3>
                <p className="text-sm text-emerald-700 dark:text-emerald-300 mt-1">
                  You're getting the best possible job matches. Keep your profile updated to maintain visibility.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center mt-4">
                  <Button 
                    onClick={() => setActiveTab('jobs')} 
                    className="bg-emerald-600 hover:bg-emerald-700"
                  >
                    View Job Matches
                  </Button>
                  <Button 
                    variant="outline"
                    onClick={() => setIsEditingProfile(true)}
                  >
                    Edit Profile
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* Profile completion card */}
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">Profile Completion</span>
                    <span className={`text-sm font-bold ${profileCompletion >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
                      {profileCompletion}%
                    </span>
                  </div>
                  <Progress value={profileCompletion} className="h-2" />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {profileCompletion < 33
                      ? 'Upload a resume to unlock AI-matched jobs'
                      : profileCompletion < 66
                        ? 'Add experience, location, or salary range to improve matches'
                        : 'Almost there — fill in the remaining fields for better matches'}
                  </p>
                </div>

                {/* Resume nudge */}
                {!hasResume && (
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                    <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      No resume on file yet. Upload one below to get AI-powered job matches.
                    </p>
                  </div>
                )}

                <ProfileWizard onComplete={() => { setActiveTab('jobs'); setIsEditingProfile(false); }} />
              </>
            )}
          </div>
        )}

        {activeTab === 'agent' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Recrutas AI Agent</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Your personal AI-powered career assistant</p>
            </div>

            {/* Feature Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Target className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Smart Job Matching</h3>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  AI analyzes your skills, experience, and preferences to find jobs that match your profile perfectly.
                </p>
                <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400 border-0">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Active
                </Badge>
              </div>

              <div className="rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Resume Optimization</h3>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  Get AI-powered suggestions to improve your resume and increase your chances with recruiters.
                </p>
                <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400 border-0">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Active
                </Badge>
              </div>

              <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Career Insights</h3>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  Discover trending skills in your industry and get personalized learning recommendations.
                </p>
                <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-400 border-0">
                  Coming Soon
                </Badge>
              </div>
            </div>

            {/* AI Tips */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Star className="h-4 w-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">AI-Powered Tips for You</h3>
              </div>
              <div className="space-y-3">
                <div className="p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-100 dark:border-blue-800">
                  <h4 className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1">Complete Your Profile</h4>
                  <p className="text-xs text-blue-700 dark:text-blue-400 mb-3">
                    Add more skills to your profile to improve your match score. Candidates with 10+ skills get 40% more job matches.
                  </p>
                  <Button size="sm" variant="outline" onClick={() => setProfileModalOpen(true)} className="h-7 text-xs">
                    <Settings className="h-3.5 w-3.5 mr-1.5" />
                    Edit Profile &amp; Skills
                  </Button>
                </div>
                <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg border border-emerald-100 dark:border-emerald-800">
                  <h4 className="text-sm font-medium text-emerald-800 dark:text-emerald-300 mb-1">Apply Early</h4>
                  <p className="text-xs text-emerald-700 dark:text-emerald-400">
                    Jobs posted in the last 24 hours have a 2x higher response rate. Check your job feed daily for new opportunities.
                  </p>
                </div>
                <div className="p-4 bg-violet-50 dark:bg-violet-950/30 rounded-lg border border-violet-100 dark:border-violet-800">
                  <h4 className="text-sm font-medium text-violet-800 dark:text-violet-300 mb-1">Engage with Recruiters</h4>
                  <p className="text-xs text-violet-700 dark:text-violet-400">
                    Respond to messages within 24 hours. Quick responses show recruiters you're actively interested.
                  </p>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => setActiveTab('jobs')} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                <Search className="h-4 w-4 mr-2" />
                Find AI-Matched Jobs
              </Button>
              <Button onClick={() => { setActiveTab('profile'); setIsEditingProfile(true); }} variant="outline">
                <User className="h-4 w-4 mr-2" />
                Update Profile
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Profile Completion Modal */}
      <ProfileCompletionModal
        open={profileModalOpen}
        onOpenChange={setProfileModalOpen}
        currentProfile={profile}
      />

      {/* Settings Modal */}
      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
      />
    </div>
  );
}

// Settings Modal Component
interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [emailNotifications, setEmailNotifications] = useState(true);
  const [jobAlerts, setJobAlerts] = useState(true);
  const [applicationUpdates, setApplicationUpdates] = useState(true);

  const { data: savedPrefs } = useQuery({
    queryKey: ['/api/candidate/notification-preferences'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/candidate/notification-preferences');
      return res.json();
    },
    enabled: open,
  });

  useEffect(() => {
    if (savedPrefs && Object.keys(savedPrefs).length > 0) {
      setEmailNotifications(savedPrefs.emailNotifications ?? true);
      setJobAlerts(savedPrefs.inAppNotifications ?? true);
      setApplicationUpdates(savedPrefs.applicationUpdates ?? true);
    }
  }, [savedPrefs]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('PUT', '/api/candidate/notification-preferences', {
        emailNotifications,
        inAppNotifications: jobAlerts,
        applicationUpdates,
      });
      if (!res.ok) {throw new Error('Failed to save');}
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/notification-preferences'] });
      toast({ title: "Settings Saved", description: "Your preferences have been updated." });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
    },
  });

  const handleSave = () => saveMutation.mutate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <div className="px-6 pt-6 pb-2">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Settings className="h-5 w-5 text-slate-500" />
              Settings
            </DialogTitle>
            <DialogDescription>
              Preferences and notifications
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-6 space-y-5">
          {/* Appearance */}
          <div className="flex items-center justify-between rounded-xl bg-slate-50 dark:bg-slate-800/50 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
                <Palette className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <Label htmlFor="theme" className="text-sm font-medium">Dark Mode</Label>
                <p className="text-xs text-slate-500">Switch theme</p>
              </div>
            </div>
            <Switch
              id="theme"
              checked={theme === 'dark'}
              onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
            />
          </div>

          {/* Notifications */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-1 mb-1">
              <Bell className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-semibold text-slate-900 dark:text-white">Email Notifications</span>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <Label htmlFor="email-notif" className="text-sm font-medium">Enable Email</Label>
                  <p className="text-xs text-slate-500">Receive notifications in your inbox</p>
                </div>
                <Switch
                  id="email-notif"
                  checked={emailNotifications}
                  onCheckedChange={setEmailNotifications}
                />
              </div>

              {emailNotifications && (
                <>
                  <div className="flex items-center justify-between px-4 py-3">
                    <div>
                      <Label htmlFor="job-alerts" className="text-sm font-medium">New Job Matches</Label>
                      <p className="text-xs text-slate-500">When jobs match your profile</p>
                    </div>
                    <Switch
                      id="job-alerts"
                      checked={jobAlerts}
                      onCheckedChange={setJobAlerts}
                    />
                  </div>
                  <div className="flex items-center justify-between px-4 py-3">
                    <div>
                      <Label htmlFor="app-updates" className="text-sm font-medium">Application Status</Label>
                      <p className="text-xs text-slate-500">Viewed, accepted, or rejected</p>
                    </div>
                    <Switch
                      id="app-updates"
                      checked={applicationUpdates}
                      onCheckedChange={setApplicationUpdates}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 mt-2 border-t border-slate-200 dark:border-slate-700">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Simple Saved Jobs List Component
function SavedJobsList() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: savedJobs, isLoading } = useQuery({
    queryKey: ['/api/candidate/saved-jobs'],
    queryFn: async () => {
      const response = await apiRequest("GET", '/api/candidate/saved-jobs');
      if (!response.ok) { throw new Error(`${response.status}`); }
      return response.json();
    },
  });

  const unsaveMutation = useMutation({
    mutationFn: async (jobId: number) => {
      await apiRequest("DELETE", `/api/candidate/saved-jobs/${jobId}`);
    },
    onMutate: async (jobId: number) => {
      await queryClient.cancelQueries({ queryKey: ['/api/candidate/saved-jobs'] });
      const prev = queryClient.getQueryData(['/api/candidate/saved-jobs']);
      queryClient.setQueryData(['/api/candidate/saved-jobs'], (old: any[]) =>
        old ? old.filter((j: any) => j.id !== jobId) : old
      );
      return { prev };
    },
    onError: (_err, _jobId, context) => {
      if (context?.prev) {queryClient.setQueryData(['/api/candidate/saved-jobs'], context.prev);}
      toast({ title: "Error", description: "Failed to unsave job.", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/saved-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/job-actions'] });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-pulse">
            <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded w-1/3 mb-2" />
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/4" />
          </div>
        ))}
      </div>
    );
  }

  if (!savedJobs || savedJobs.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
          <Bookmark className="h-6 w-6 text-gray-400" />
        </div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">No saved jobs yet</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">Jobs you save will appear here for easy access</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {savedJobs.map((job: any) => (
        <div key={job.id} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
          <div className="flex justify-between items-start gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white leading-tight">{job.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{job.company}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{job.location}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs border-gray-200 dark:border-gray-700"
                onClick={() => {
                  if (job.externalUrl) {
                    window.open(job.externalUrl, '_blank');
                  } else {
                    setLocation(`/candidate-dashboard?tab=jobs&job=${job.id}`);
                  }
                }}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1" />
                View
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                onClick={() => unsaveMutation.mutate(job.id)}
                disabled={unsaveMutation.isPending}
                title="Remove from saved"
              >
                <Bookmark className="h-3.5 w-3.5 fill-current" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
