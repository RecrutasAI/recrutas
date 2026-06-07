import { useState, useMemo, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, MapPin, Building, Filter, ExternalLink, Briefcase, Bookmark, EyeOff, Check, Sparkles, Shield, BadgeCheck, RotateCcw, Clock, FileText, Upload, Loader2, Layers, Calendar, ChevronDown } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import AIMatchBreakdownModal from "./AIMatchBreakdownModal";
import { LoadingHype } from "./loading-hype";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics";

function isCareerPageLink(url: string | undefined, careerPageUrl: string | undefined): boolean {
  if (!url) return false;
  if (!careerPageUrl) return false;

  const urlClean = url.replace(/\/$/, '').toLowerCase();
  const careerClean = careerPageUrl.replace(/\/$/, '').toLowerCase();

  if (urlClean === careerClean) return true;

  // ATS-aware classification: a "company" URL is the bare board landing,
  // a "job" URL is a specific posting on that board.
  const atsPatterns: Array<{ company: RegExp; job: RegExp }> = [
    {
      // Greenhouse: boards.greenhouse.io/<slug> vs .../<slug>/jobs/<id>
      company: /boards\.greenhouse\.io\/[a-z0-9-]+$/i,
      job: /boards\.greenhouse\.io\/[a-z0-9-]+\/jobs\/\d+/i,
    },
    {
      // Lever: jobs.lever.co/<slug> vs .../<slug>/<uuid-or-id>(/apply)?
      company: /jobs\.lever\.co\/[a-z0-9-]+\/?$/i,
      job: /jobs\.lever\.co\/[a-z0-9-]+\/[\w-]+/i,
    },
    {
      // Workday: <tenant>.wd<n>.myworkdayjobs.com/<site> vs .../job/<location>/<title>_<id>
      company: /\.wd\d+\.myworkdayjobs\.com(?:\/[\w-]+)*\/?$/i,
      job: /\.wd\d+\.myworkdayjobs\.com.*\/job\//i,
    },
    {
      // Ashby: jobs.ashbyhq.com/<slug> vs .../<slug>/<uuid>
      company: /jobs\.ashbyhq\.com\/[a-z0-9-]+\/?$/i,
      job: /jobs\.ashbyhq\.com\/[a-z0-9-]+\/[\w-]{6,}/i,
    },
  ];

  for (const { company, job } of atsPatterns) {
    if (job.test(urlClean)) return false;
    if (company.test(urlClean)) return true;
  }

  // Fallback: only treat as a career page if the URL is the careers URL or
  // strictly shallower. A URL deeper than the careers page is a posting.
  const urlPathSegments = urlClean.split('/').filter(Boolean);
  const careerPathSegments = careerClean.split('/').filter(Boolean);

  if (urlPathSegments.length <= careerPathSegments.length) {
    return urlClean.startsWith(careerClean) || careerClean.startsWith(urlClean);
  }

  return false;
}

function getUrlLabel(url: string | undefined, careerPageUrl: string | undefined): { label: string; description: string } {
  if (!url) {
    return { label: 'Internal Posting', description: 'Apply through Recrutas' };
  }
  
  if (isCareerPageLink(url, careerPageUrl)) {
    return { label: 'Company Career Page', description: 'Browse all open positions' };
  }
  
  return { label: 'Job Posting', description: 'Direct link to job application' };
}


type ExperienceLevel = 'entry' | 'mid' | 'senior' | 'lead' | 'executive';

function inferJobLevel(title: string): ExperienceLevel {
  const t = (title || '').toLowerCase();
  if (/director|vp|vice president|head of|chief|cto|ceo/i.test(t)) return 'executive';
  if (/lead|manager|principal/i.test(t)) return 'lead';
  if (/senior|sr\.|staff/i.test(t)) return 'senior';
  if (/junior|entry|intern|associate|new grad/i.test(t)) return 'entry';
  return 'mid';
}

const EXPERIENCE_LEVEL_LABELS: Record<ExperienceLevel, string> = {
  entry: 'Entry Level',
  mid: 'Mid Level',
  senior: 'Senior',
  lead: 'Lead',
  executive: 'Executive',
};

const DATE_FILTER_OPTIONS: { value: string; label: string; days: number }[] = [
  { value: '1d', label: 'Past 24 hours', days: 1 },
  { value: '3d', label: 'Past 3 days', days: 3 },
  { value: '7d', label: 'Past week', days: 7 },
  { value: '14d', label: 'Past 2 weeks', days: 14 },
  { value: '30d', label: 'Past month', days: 30 },
];

// The ingested `workType` is unreliable (set by many loose heuristics) and the
// true arrangement often only lives in the job description, so we don't treat
// the filter as exact. "Remote" means "has a remote component" (remote OR
// hybrid) so picking it never surfaces a pure-onsite role — which was the actual
// complaint; the rest match their own type. Keys/values are lowercased.
const WORK_TYPE_FILTER_ACCEPTS: Record<string, string[]> = {
  remote: ['remote', 'hybrid'],
  hybrid: ['hybrid'],
  onsite: ['onsite'],
};

export interface AIJobMatch {
  id: number;
  job: {
    id: number;
    title: string;
    company: string;
    location: string;
    workType: string;
    salaryMin: number;
    salaryMax: number;
    description: string;
    requirements: string[];
    skills: string[];
    aiCurated: boolean;
    confidenceScore: number;
    externalSource?: string;
    externalUrl?: string;
    careerPageUrl?: string;
    postedDate?: string;
    trustScore?: number;
    livenessStatus?: 'active' | 'stale' | 'unknown';
    hasExam?: boolean;
  };
  matchScore: string;
  confidenceLevel: number;
  skillMatches: string[];
  partialSkillMatches?: string[];
  scoreComponents?: {
    keywordScore: number;
    semanticScore: number;
    titleScore: number;
    experienceScore: number;
    contextBonus: number;
    hasSemanticSignal: boolean;
  };
  aiExplanation: string;
  status: string;
  createdAt: string;
  // PRD fields
  isVerifiedActive?: boolean;
  isDirectFromCompany?: boolean;
  isNew?: boolean;
}

interface PaginatedResponse {
  jobs: AIJobMatch[];
  total: number;
  page: number;
  hasMore: boolean;
}

const JOBS_PER_PAGE = 20;
// The matcher hard-caps recommendations at 100, so the entire feed fits in one
// request — fetched up front so all filters operate on the complete set.
const FEED_FETCH_LIMIT = 100;

interface AIJobFeedProps {
  onUploadClick?: () => void;
}

export default function AIJobFeed({ onUploadClick }: AIJobFeedProps) {
  const [, setLocation] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [workTypeFilter, setWorkTypeFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [experienceLevelFilter, setExperienceLevelFilter] = useState("all");
  const [datePostedFilter, setDatePostedFilter] = useState("all");
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<AIJobMatch | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Read candidate profile from cache (parent dashboard already fetches it)
  const cachedProfile = queryClient.getQueryData<any>(['/api/candidate/profile']);
  const hasSkills = Array.isArray(cachedProfile?.skills) && cachedProfile.skills.length > 0;

  // Single fetch of the full (≤100) match set. All six filters below run
  // client-side over this COMPLETE set — previously filtering only saw the pages
  // an infinite scroll had loaded, which silently hid matching jobs on unfetched
  // pages, left the filter dropdowns incomplete, and could show a false "no
  // matches". Progressive rendering is done client-side via `visibleCount`.
  const {
    data,
    isLoading,
    isFetching,
    refetch,
  } = useQuery<PaginatedResponse>({
    queryKey: ['/api/ai-matches'],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/ai-matches?page=1&limit=${FEED_FETCH_LIMIT}`);
      return response.json();
    },
    refetchInterval: 300000,
  });

  const totalMatches = data?.total ?? 0;

  // Defensively filter: a response with undefined/null `jobs` would otherwise
  // let a downstream `.job.X` access crash.
  const allMatches = useMemo(() => {
    if (!data) return undefined;
    return (data.jobs ?? []).filter((m: any) => m && m.job);
  }, [data]);

  // How many of the filtered results are currently rendered (client-side reveal).
  const [visibleCount, setVisibleCount] = useState(JOBS_PER_PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Aggregator fallback — only fetched when the main feed has zero matches.
  // These are external aggregator listings (Adzuna et al.); URLs leave the platform.
  // Matched to the candidate using the same signals as the main feed: profile
  // skills, the active search/title intent, location, and work-type filter.
  const hasZeroMatches = !isLoading && !isFetching && allMatches !== undefined && allMatches.length === 0;
  const candidateSkills: string[] = useMemo(() => {
    const skills = cachedProfile?.skills;
    return Array.isArray(skills) ? skills.slice(0, 20) : [];
  }, [cachedProfile?.skills]);
  const fallbackLocation = locationFilter !== 'all' ? locationFilter : (cachedProfile?.location || '');
  const fallbackWorkType = workTypeFilter !== 'all' ? workTypeFilter : '';
  const fallbackJobTitle = searchTerm.trim();
  const { data: fallbackData } = useQuery<{ jobs: any[] }>({
    queryKey: ['/api/aggregator-fallback', candidateSkills.join(','), fallbackJobTitle, fallbackLocation, fallbackWorkType],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (candidateSkills.length > 0) params.set('skills', candidateSkills.join(','));
      if (fallbackJobTitle) params.set('jobTitle', fallbackJobTitle);
      if (fallbackLocation) params.set('location', fallbackLocation);
      if (fallbackWorkType) params.set('workType', fallbackWorkType);
      const response = await apiRequest("GET", `/api/aggregator-fallback?${params.toString()}`);
      return response.json();
    },
    enabled: hasZeroMatches,
    staleTime: 5 * 60 * 1000,
  });
  const fallbackJobs = fallbackData?.jobs ?? [];

  // Client-side filtering — instant, no network calls
  const filteredMatches = useMemo(() => {
    if (!allMatches) return undefined;
    const term = searchTerm.toLowerCase().trim();
    const dateOption = DATE_FILTER_OPTIONS.find(o => o.value === datePostedFilter);
    const dateCutoff = dateOption ? Date.now() - dateOption.days * 24 * 60 * 60 * 1000 : null;
    return allMatches.filter(m => {
      if (term && !m.job.title.toLowerCase().includes(term) && !m.job.company.toLowerCase().includes(term) && !(m.job.description || '').toLowerCase().includes(term)) return false;
      if (locationFilter !== 'all' && m.job.location !== locationFilter) return false;
      if (workTypeFilter !== 'all') {
        const key = workTypeFilter.toLowerCase();
        const accepts = WORK_TYPE_FILTER_ACCEPTS[key] ?? [key];
        if (!accepts.includes((m.job.workType || '').toLowerCase())) return false;
      }
      if (companyFilter !== 'all' && m.job.company !== companyFilter) return false;
      if (experienceLevelFilter !== 'all') {
        const level = inferJobLevel(m.job.title);
        // When filtering for entry level, also include mid (many entry jobs lack "junior" in title)
        if (experienceLevelFilter === 'entry') {
          if (level !== 'entry' && level !== 'mid') return false;
        } else {
          if (level !== experienceLevelFilter) return false;
        }
      }
      if (dateCutoff !== null) {
        if (!m.job.postedDate) return false;
        const posted = new Date(m.job.postedDate).getTime();
        if (isNaN(posted) || posted < dateCutoff) return false;
      }
      return true;
    });
  }, [allMatches, searchTerm, locationFilter, workTypeFilter, companyFilter, experienceLevelFilter, datePostedFilter]);

  // The window of filtered results actually rendered. Slicing caps gracefully,
  // so an over-incremented visibleCount is harmless.
  const visibleMatches = useMemo(
    () => filteredMatches?.slice(0, visibleCount),
    [filteredMatches, visibleCount],
  );
  const hasMoreToShow = !!filteredMatches && visibleCount < filteredMatches.length;

  // Reset the reveal window whenever the filter set changes so a new filter
  // starts from the top instead of inheriting a deep scroll position.
  useEffect(() => {
    setVisibleCount(JOBS_PER_PAGE);
  }, [searchTerm, locationFilter, workTypeFilter, companyFilter, experienceLevelFilter, datePostedFilter]);

  // Reveal more on scroll (purely client-side — no network). Re-bound when the
  // filtered set changes so the cap tracks the current result count.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !filteredMatches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount(c => Math.min(c + JOBS_PER_PAGE, filteredMatches.length));
        }
      },
      // Root MUST be the scrolling list container, not the viewport: the list
      // lives inside an `overflow-y-auto` div, so a viewport-rooted observer
      // never sees the sentinel scroll into view — the reveal stalls at ~40 and
      // only advances incidentally (on mount / refetch), which is the bug where
      // the feed shows 40 and "Refresh" bumps it +20 toward 100.
      { root: scrollContainerRef.current, rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [filteredMatches]);

  const { data: userJobActions } = useQuery({
    queryKey: ['/api/candidate/job-actions'],
    queryFn: async () => {
      const response = await apiRequest("GET", '/api/candidate/job-actions');
      const data = await response.json();
      return {
        saved: new Set<number>(data?.saved || []),
        applied: new Set<number>(data?.applied || []),
      };
    },
  });

  const savedJobIds = userJobActions?.saved ?? new Set();
  const appliedJobIds = userJobActions?.applied ?? new Set();

  const applyMutation = useMutation({
    mutationFn: async (jobId: number) => {
      const res = await apiRequest("POST", `/api/candidate/apply/${jobId}`, {});
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: 'Application failed' }));
        throw new Error(data.message || `Application failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (_data, jobId) => {
      track('application_submitted', { job_id: jobId });
      toast({ title: "Application Tracked!", description: "We've marked this job as applied." });
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/job-actions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/applications'] });
    },
    onError: (error: any) => toast({ title: "Error", description: error.message, variant: "destructive" }),
  });

  const saveMutation = useMutation({
    mutationFn: (jobId: number) => apiRequest("POST", '/api/candidate/saved-jobs', { jobId }),
    onMutate: async (jobId: number) => {
      await queryClient.cancelQueries({ queryKey: ['/api/candidate/job-actions'] });
      const previousJobActions = queryClient.getQueryData(['/api/candidate/job-actions']);
      queryClient.setQueryData(['/api/candidate/job-actions'], (oldData: any) => {
        if (!oldData) {return oldData;}
        return {
          ...oldData,
          saved: new Set(oldData.saved).add(jobId),
        };
      });
      return { previousJobActions };
    },
    onSuccess: () => {
      toast({ title: "Job Saved!" });
    },
    onError: (err, variables, context) => {
      if (context?.previousJobActions) {
        queryClient.setQueryData(['/api/candidate/job-actions'], context.previousJobActions);
      }
      toast({ title: "Error", description: "Failed to save job.", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/job-actions'] });
    },
  });

  const unsaveMutation = useMutation({
    mutationFn: (jobId: number) => apiRequest("DELETE", `/api/candidate/saved-jobs/${jobId}`),
    onMutate: async (jobId: number) => {
      await queryClient.cancelQueries({ queryKey: ['/api/candidate/job-actions'] });
      const previousJobActions = queryClient.getQueryData(['/api/candidate/job-actions']);
      queryClient.setQueryData(['/api/candidate/job-actions'], (oldData: any) => {
        if (!oldData) {return oldData;}
        const newSaved = new Set(oldData.saved);
        newSaved.delete(jobId);
        return { ...oldData, saved: newSaved };
      });
      return { previousJobActions };
    },
    onSuccess: () => {
      toast({ title: "Job Unsaved" });
    },
    onError: (err, variables, context) => {
      if (context?.previousJobActions) {
        queryClient.setQueryData(['/api/candidate/job-actions'], context.previousJobActions);
      }
      toast({ title: "Error", description: "Failed to unsave job.", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/job-actions'] });
    },
  });

  const hideMutation = useMutation({
    mutationFn: (jobId: number) => apiRequest("POST", '/api/candidate/hidden-jobs', { jobId }),
    onMutate: async (jobId: number) => {
      await queryClient.cancelQueries({ queryKey: ['/api/ai-matches'] });
      const previousMatches = queryClient.getQueryData(['/api/ai-matches']);
      queryClient.setQueryData(['/api/ai-matches'], (oldData: any) => {
        if (!oldData?.jobs) return oldData;
        const jobs = oldData.jobs.filter((match: AIJobMatch) => match.job.id !== jobId);
        return { ...oldData, jobs, total: Math.max(0, (oldData.total ?? jobs.length) - 1) };
      });
      return { previousMatches };
    },
    onSuccess: () => {
      toast({ title: "Job Hidden", description: "You won't see this job in your feed anymore." });
    },
    onError: (err, variables, context) => {
      if (context?.previousMatches) {
        queryClient.setQueryData(['/api/ai-matches'], context.previousMatches);
      }
      toast({ title: "Error", description: "Failed to hide job.", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/ai-matches'] });
    },
  });

  const handleApply = (e: React.MouseEvent, match: AIJobMatch) => {
    e.stopPropagation();
    if (appliedJobIds.has(match.job.id)) {return;}
    const isInternal = !match.job.externalUrl;
    applyMutation.mutate(match.job.id, {
      onSuccess: () => {
        if (isInternal && match.job.hasExam) {
          setLocation(`/exam/${match.job.id}`);
        }
      },
    });
    if (match.job.externalUrl) {
      const isCareerPage = isCareerPageLink(match.job.externalUrl, match.job.careerPageUrl);
      toast({
        title: isCareerPage ? 'Opening Company Career Page' : 'Opening External Application',
        description: isCareerPage 
          ? `You'll be redirected to ${match.job.company}'s career page to find this position.`
          : `You'll be redirected to ${match.job.company}'s job posting. We've tracked this application for you.`,
      });
      setTimeout(() => {
        const url = isCareerPage && match.job.careerPageUrl ? match.job.careerPageUrl : match.job.externalUrl;
        window.open(url, '_blank');
      }, 500);
    } else if (!match.job.hasExam) {
      toast({
        title: "Application Submitted",
        description: `Your application for ${match.job.title} at ${match.job.company} has been sent.`,
      });
    }
  };

  const handleSaveToggle = (e: React.MouseEvent, match: AIJobMatch) => {
    e.stopPropagation();
    if (savedJobIds.has(match.job.id)) {
      unsaveMutation.mutate(match.job.id);
    } else {
      saveMutation.mutate(match.job.id);
    }
  };

  const handleHide = (e: React.MouseEvent, match: AIJobMatch) => {
    e.stopPropagation();
    hideMutation.mutate(match.job.id);
  };

  const locations = useMemo(() => [...new Set((allMatches || []).map(m => m.job.location).filter(Boolean))].sort(), [allMatches]);
  const companies = useMemo(() => [...new Set((allMatches || []).map(m => m.job.company).filter(Boolean))].sort(), [allMatches]);
  const workTypes = useMemo(() => [...new Set((allMatches || []).map(m => m.job.workType).filter(Boolean))].sort(), [allMatches]);

  const clearFilters = () => {
    setSearchTerm("");
    setLocationFilter("all");
    setWorkTypeFilter("all");
    setCompanyFilter("all");
    setExperienceLevelFilter("all");
    setDatePostedFilter("all");
  };

  const activeFilterCount =
    (locationFilter !== 'all' ? 1 : 0) +
    (workTypeFilter !== 'all' ? 1 : 0) +
    (companyFilter !== 'all' ? 1 : 0) +
    (experienceLevelFilter !== 'all' ? 1 : 0) +
    (datePostedFilter !== 'all' ? 1 : 0);
  const hasAnyFilter = activeFilterCount > 0 || searchTerm.length > 0;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-3 sm:p-4 shadow-sm border">
        {/* Search row + mobile filter toggle */}
        <div className="flex gap-2 sm:gap-3 items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search jobs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 w-full"
            />
          </div>
          {/* Mobile-only: filters toggle */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowMobileFilters(v => !v)}
            className="sm:hidden shrink-0 relative"
            aria-expanded={showMobileFilters}
            aria-controls="job-feed-filters"
          >
            <Filter className="h-4 w-4 mr-1" />
            Filters
            {activeFilterCount > 0 && (
              <Badge className="ml-1.5 h-5 min-w-5 px-1.5 bg-blue-600 text-white text-[10px]">
                {activeFilterCount}
              </Badge>
            )}
            <ChevronDown className={`h-4 w-4 ml-1 transition-transform ${showMobileFilters ? 'rotate-180' : ''}`} />
          </Button>
        </div>

        {/* Filter dropdowns: 2-col grid on mobile (collapsible), inline row on desktop */}
        <div
          id="job-feed-filters"
          className={`${showMobileFilters ? 'grid' : 'hidden'} grid-cols-2 gap-2 mt-3 sm:mt-3 sm:flex sm:flex-row sm:flex-wrap sm:gap-3`}
        >
          <Select value={datePostedFilter} onValueChange={setDatePostedFilter}>
            <SelectTrigger className="w-full sm:w-[150px]">
              <Calendar className="h-4 w-4 mr-2 shrink-0" />
              <SelectValue placeholder="Date Posted" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any time</SelectItem>
              {DATE_FILTER_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={locationFilter} onValueChange={setLocationFilter}>
            <SelectTrigger className="w-full sm:w-[140px]">
              <MapPin className="h-4 w-4 mr-2 shrink-0" />
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Locations</SelectItem>
              {locations.map(loc => (
                <SelectItem key={loc} value={loc}>{loc}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={workTypeFilter} onValueChange={setWorkTypeFilter}>
            <SelectTrigger className="w-full sm:w-[140px]">
              <Briefcase className="h-4 w-4 mr-2 shrink-0" />
              <SelectValue placeholder="Work Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {workTypes.map(type => (
                <SelectItem key={type} value={type}>{type}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={companyFilter} onValueChange={setCompanyFilter}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <Building className="h-4 w-4 mr-2 shrink-0" />
              <SelectValue placeholder="Company" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Companies</SelectItem>
              {companies.map(company => (
                <SelectItem key={company} value={company}>{company}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={experienceLevelFilter} onValueChange={setExperienceLevelFilter}>
            <SelectTrigger className="w-full sm:w-[150px]">
              <Layers className="h-4 w-4 mr-2 shrink-0" />
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              {(Object.keys(EXPERIENCE_LEVEL_LABELS) as ExperienceLevel[]).map(level => (
                <SelectItem key={level} value={level}>{EXPERIENCE_LEVEL_LABELS[level]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasAnyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="col-span-2 sm:col-span-1 shrink-0">
              <Filter className="h-4 w-4 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Job Feed */}
      {isLoading || (isFetching && (!filteredMatches || filteredMatches.length === 0)) ? (
        <LoadingHype />
      ) : allMatches && allMatches.length > 0 && filteredMatches && filteredMatches.length === 0 && hasAnyFilter ? (
        /* The candidate HAS matches — the active filters just excluded them all.
           Don't show the "no matches yet" hero (misleading); offer to clear. */
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-center rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
          <div className="h-10 w-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
            <Filter className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-gray-900 dark:text-white">
              No jobs match your filters
            </h3>
            <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-0.5">
              None of your {totalMatches} matches fit the current filters. Try widening or clearing them.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={clearFilters}>
            <RotateCcw className="h-4 w-4 mr-1" />
            Clear filters
          </Button>
        </div>
      ) : !filteredMatches || filteredMatches.length === 0 ? (
        <div className="space-y-4">
          {/* Encouraging hero strip — same width as cards, friendlier tone */}
          <div className="flex items-start sm:items-center gap-3 sm:gap-4 p-4 rounded-xl bg-gradient-to-r from-emerald-50 to-blue-50 dark:from-emerald-950/30 dark:to-blue-950/30 border border-emerald-200/60 dark:border-emerald-800/40">
            <div className="h-10 w-10 rounded-full bg-white dark:bg-gray-900 flex items-center justify-center shrink-0 shadow-sm">
              <Sparkles className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm sm:text-base font-semibold text-gray-900 dark:text-white">
                {fallbackJobs.length > 0
                  ? "We're sharpening your matches"
                  : "Hang tight — new matches arrive daily"}
              </h3>
              <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                {fallbackJobs.length > 0
                  ? "While our top-tier matches catch up, here are roles aligned to your profile from across the web."
                  : "Polish your profile to surface more matches, or check back soon — fresh opportunities are added every hour."}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => onUploadClick?.()} className="text-xs">
                <Upload className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Profile</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="text-xs" title="Refresh matches">
                <RotateCcw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {/* Fallback jobs rendered as full feed cards — same visual weight as real matches */}
          {fallbackJobs.length > 0 && (
            <div className="space-y-4 max-h-[calc(100vh-350px)] overflow-y-auto">
              {fallbackJobs.map((job: any) => (
                <Card
                  key={job.id}
                  className="hover:shadow-md transition-all duration-150 hover:border-blue-200 dark:hover:border-blue-800 cursor-pointer"
                  onClick={() => {
                    track('aggregator_fallback_click', { jobId: job.id, source: job.source });
                    window.open(job.externalUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <CardContent className="p-3 sm:p-4">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <Badge variant="secondary" className="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 text-xs">
                            <ExternalLink className="h-3 w-3 mr-1" />
                            via {job.source}
                          </Badge>
                        </div>
                        <h3 className="font-semibold text-base sm:text-lg leading-tight">
                          <span className="line-clamp-2 sm:line-clamp-1">{job.title}</span>
                        </h3>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-y-1 sm:gap-x-3 text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">
                          <div className="flex items-center">
                            <Building className="h-3 w-3 sm:h-4 sm:w-4 mr-1 shrink-0" /> {job.company}
                          </div>
                          {job.location && (
                            <div className="flex items-center">
                              <MapPin className="h-3 w-3 sm:h-4 sm:w-4 mr-1 shrink-0" /> {job.location}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 self-end sm:self-start">
                        <Button variant="outline" size="sm" className="text-xs">
                          Open
                          <ExternalLink className="h-3 w-3 ml-1" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Job count summary with refresh */}
          <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
            <span>
              Showing {visibleMatches?.length ?? 0} of {filteredMatches.length}
              {filteredMatches.length !== totalMatches ? ` (filtered from ${totalMatches})` : ''} matches
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-2"
            >
              <RotateCcw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
              {isFetching ? 'Refreshing...' : 'Refresh'}
            </Button>
          </div>

          <div ref={scrollContainerRef} className="space-y-4 max-h-[calc(100vh-350px)] overflow-y-auto">
            {visibleMatches!.map((match, idx) => {
              const isSaved = savedJobIds.has(match.job.id);
              const isApplied = appliedJobIds.has(match.job.id);
              // Determine trust badges
              const isVerifiedActive = match.isVerifiedActive || (match.job.trustScore && match.job.trustScore >= 85 && match.job.livenessStatus === 'active');
              const isDirectFromCompany = match.isDirectFromCompany || match.job.externalSource === 'internal' || match.job.externalSource === 'platform';
              const isInternalJob = (match.job as any).source === 'platform' || match.job.externalSource === 'platform' || !match.job.externalUrl;
              return (
                <div key={match.id}>
                  <Card className={`hover:shadow-md transition-all duration-150 ${isInternalJob ? 'border-l-4 border-l-emerald-500 hover:border-emerald-300 dark:hover:border-emerald-700 bg-emerald-50/30 dark:bg-emerald-950/10' : 'hover:border-blue-200 dark:hover:border-blue-800'}`}>
                    <CardContent className="p-3 sm:p-4">
                      {/* Mobile: Stack vertically, Desktop: Side by side */}
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            {match.isNew && (
                              <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 text-xs">
                                <Clock className="h-3 w-3 mr-1" />
                                New
                              </Badge>
                            )}
                            {match.job.aiCurated && (
                              <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300 text-xs">
                                <Sparkles className="h-3 w-3 mr-1" />
                                AI Curated
                              </Badge>
                            )}
                            {isVerifiedActive && (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300 text-xs">
                                <BadgeCheck className="h-3 w-3 mr-1" />
                                Verified Active
                              </Badge>
                            )}
                            {isDirectFromCompany && (
                              <Badge variant="secondary" className="bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300 text-xs">
                                <Shield className="h-3 w-3 mr-1" />
                                Direct
                              </Badge>
                            )}
                            {isInternalJob && (
                              <Badge className="bg-emerald-600 text-white text-xs font-semibold">
                                <Clock className="h-3 w-3 mr-1" />
                                24h Response
                              </Badge>
                            )}
                            {isInternalJob && match.job.hasExam && (
                              <Badge variant="secondary" className="bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300 text-xs">
                                <FileText className="h-3 w-3 mr-1" />
                                Has Exam
                              </Badge>
                            )}
                            <span className="text-xs text-gray-500 hidden sm:inline">Match: {match.matchScore}</span>
                          </div>
                          <h3 className="font-semibold text-base sm:text-lg leading-tight">
                            <span className="line-clamp-2 sm:line-clamp-1">{match.job.title}</span>
                          </h3>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-y-1 sm:gap-x-3 text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">
                            <div className="flex items-center">
                              <Building className="h-3 w-3 sm:h-4 sm:w-4 mr-1 shrink-0" /> {match.job.company}
                            </div>
                            <div className="flex items-center">
                              <MapPin className="h-3 w-3 sm:h-4 sm:w-4 mr-1 shrink-0" /> {match.job.location}
                            </div>
                            {match.job.workType && (
                              <div className="flex items-center">
                                <Briefcase className="h-3 w-3 sm:h-4 sm:w-4 mr-1 shrink-0" />
                                <span className="capitalize">{match.job.workType}</span>
                              </div>
                            )}
                          </div>

                          {/* PRD: "Why You're a Match" explanation */}
                          <div className="mt-2 text-xs sm:text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                            <span className="font-medium text-blue-600 dark:text-blue-400">Why you match:</span>{' '}
                            {match.aiExplanation || (match.skillMatches && match.skillMatches.length > 0
                              ? `Strong match for ${match.skillMatches.slice(0, 2).join(' & ')}`
                              : 'Skills and experience align with this role')}
                          </div>
                        </div>
                        {/* Mobile: Full width buttons, Desktop: Right side buttons */}
                        <div className="flex flex-row sm:flex-col lg:flex-row items-center gap-2 sm:gap-1.5 lg:gap-2 sm:shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-100 dark:border-gray-700">
                          <Button
                            size="sm"
                            variant={isApplied ? "outline" : "default"}
                            onClick={(e) => handleApply(e, match)}
                            disabled={isApplied || applyMutation.isPending}
                            className={`flex-1 sm:flex-none text-xs sm:text-sm ${isApplied ? 'border-green-400 text-green-700 dark:border-green-600 dark:text-green-400' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                            title={match.job.externalUrl ? "Opens company career page in new tab" : isInternalJob && match.job.hasExam ? "Apply and take the screening exam" : "Submit application for this job"}
                          >
                            {applyMutation.isPending
                              ? <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2 animate-spin" />
                              : isApplied
                                ? <Check className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                                : isInternalJob && match.job.hasExam
                                  ? <FileText className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                                  : <ExternalLink className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />}
                            <span className="hidden sm:inline">
                              {applyMutation.isPending ? "Applying..." : isApplied ? "Applied" : isInternalJob && match.job.hasExam ? "Apply & Take Exam" : match.job.externalUrl ? "Apply Externally" : "Apply Now"}
                            </span>
                            <span className="sm:hidden">{applyMutation.isPending ? "..." : isApplied ? "Applied" : isInternalJob && match.job.hasExam ? "Exam" : "Apply"}</span>
                          </Button>
                          <div className="flex items-center gap-1 sm:gap-1.5 lg:gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => handleSaveToggle(e, match)}
                              disabled={saveMutation.isPending || unsaveMutation.isPending}
                              className="px-2 sm:px-2.5"
                            >
                              {(saveMutation.isPending || unsaveMutation.isPending)
                                ? <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
                                : <Bookmark className={`h-3 w-3 sm:h-4 sm:w-4 ${isSaved ? "fill-current text-yellow-500" : ""}`} />}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => handleHide(e, match)}
                              disabled={hideMutation.isPending}
                              className="px-2 sm:px-2.5"
                            >
                              {hideMutation.isPending
                                ? <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
                                : <EyeOff className="h-3 w-3 sm:h-4 sm:w-4" />}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => { e.stopPropagation(); setSelectedMatch(match); setIsModalOpen(true); }}
                              className="px-2 sm:px-2.5"
                            >
                              <Sparkles className="h-3 w-3 sm:h-4 sm:w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                      {match.job.externalUrl && (
                        <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                          <div className="flex items-center">
                            {match.job.postedDate && (
                              <span>Posted {new Date(match.job.postedDate).toLocaleDateString()}</span>
                            )}
                          </div>
                          {(() => {
                            const isCareerPage = isCareerPageLink(match.job.externalUrl, match.job.careerPageUrl);
                            const urlInfo = getUrlLabel(match.job.externalUrl, match.job.careerPageUrl);
                            return (
                              <a
                                href={isCareerPage && match.job.careerPageUrl ? match.job.careerPageUrl : match.job.externalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline flex items-center"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3 mr-1" />
                                {urlInfo.label}
                              </a>
                            );
                          })()}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              );
            })}

            {/* Infinite scroll sentinel — MUST live inside the scroll container so
                the container-rooted observer can see it cross the reveal window. */}
            <div ref={sentinelRef} className="flex items-center justify-center h-10">
              {!hasMoreToShow && filteredMatches.length > 0 && (
                <span className="text-sm text-gray-400">You've seen all {filteredMatches.length} matches</span>
              )}
            </div>
          </div>
        </div>
      )}
      <AIMatchBreakdownModal
        match={selectedMatch}
        isOpen={isModalOpen}
        onOpenChange={setIsModalOpen}
      />
    </div>
  );
}

