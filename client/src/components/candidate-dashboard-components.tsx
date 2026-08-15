import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stripHtml } from "@/utils/string.utils";
import { Building, MapPin, DollarSign, ExternalLink, MessageSquare, BookOpen, Star, Briefcase, Clock, CheckCircle, XCircle, Clock3, AlertCircle } from "lucide-react";

const getStatusColor = (status: string): string => {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    applied: "bg-blue-100 text-blue-800",
    viewing: "bg-purple-100 text-purple-800",
    shortlisted: "bg-green-100 text-green-800",
    interview: "bg-indigo-100 text-indigo-800",
    offer: "bg-teal-100 text-teal-800",
    rejected: "bg-red-100 text-red-800",
    withdrawn: "bg-gray-100 text-gray-800",
  };
  return colors[status.toLowerCase()] || "bg-gray-100 text-gray-800";
};

const getStatusIcon = (status: string) => {
  const icons: Record<string, JSX.Element> = {
    pending: <Clock3 className="w-3 h-3" />,
    applied: <CheckCircle className="w-3 h-3" />,
    viewing: <BookOpen className="w-3 h-3" />,
    shortlisted: <Star className="w-3 h-3" />,
    interview: <Briefcase className="w-3 h-3" />,
    offer: <CheckCircle className="w-3 h-3" />,
    rejected: <XCircle className="w-3 h-3" />,
    withdrawn: <AlertCircle className="w-3 h-3" />,
  };
  return icons[status.toLowerCase()] || <Clock3 className="w-3 h-3" />;
};

interface JobMatch {
  id: number;
  jobId: number;
  status: string;
  matchScore: number;
  createdAt: string;
  job?: {
    id: number;
    title: string;
    company: string;
    location: string;
    salaryMin: number;
    salaryMax: number;
    workType: string;
    description: string;
    source: string;
    hasExam: boolean;
    externalUrl?: string;
    careerPageUrl?: string;
  };
}

interface JobMatchCardProps {
  match: JobMatch;
  onTakeExam: (jobId: number, jobTitle: string) => void;
  onApply: (jobId: number) => void;
  onStartChat: (jobId: number) => void;
  onMarkApplied: (matchId: number) => void;
  formatSalary: (min?: number, max?: number) => string;
  getStatusColor: (status: string) => string;
  getStatusIcon: (status: string) => React.ReactNode;
  timeAgo: (date: string) => string;
}

// Job match card component
export function JobMatchCard({ match, onTakeExam, onApply, onStartChat, onMarkApplied, formatSalary, getStatusColor, getStatusIcon, timeAgo }: JobMatchCardProps) {
  return (
    <div className={`border rounded-lg p-6 transition-all duration-200 hover:shadow-md ${
      match.job?.source === 'internal' 
        ? 'border-blue-200 bg-blue-50/30 hover:border-blue-300' 
        : 'border-slate-200 hover:border-orange-300'
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <JobMatchBadges match={match} />
          
          <h3 className="font-semibold text-lg text-slate-900 mb-2">
            {match.job?.title || 'Job Title Unavailable'}
          </h3>
          
          <div className="flex items-center space-x-1 text-slate-600 mb-2">
            <Building className="w-4 h-4" />
            <span className="font-medium">{match.job?.company || 'Company Unavailable'}</span>
          </div>
          
          <JobMatchDetails match={match} formatSalary={formatSalary} />
          
          {/* stripHtml first: scraped descriptions are HTML-escaped, so slicing
              the raw string renders "&lt;p data-pm-slice=..." to the candidate.
              Slice after stripping, or the budget is spent on markup. */}
          {stripHtml(match.job?.description ?? '') && (
            <p className="text-sm text-slate-600 mb-4 line-clamp-2">
              {stripHtml(match.job!.description!).slice(0, 150)}…
            </p>
          )}
        </div>
        
        <JobMatchActions 
          match={match}
          onTakeExam={onTakeExam}
          onApply={onApply}
          onStartChat={onStartChat}
          onMarkApplied={onMarkApplied}
          timeAgo={timeAgo}
        />
      </div>
    </div>
  );
}

// Job match badges component
function JobMatchBadges({ match }: { match: any }) {
  return (
    <div className="flex items-center space-x-2 mb-2 flex-wrap gap-2">
      {match.job?.source === 'internal' ? (
        <Badge className="bg-blue-100 text-blue-800 border-blue-300">
          🎯 Platform Job
        </Badge>
      ) : (
        <Badge variant="outline" className="bg-orange-50 text-orange-600 border-orange-200">
          🌐 External
        </Badge>
      )}
      
      {match.job?.source === 'internal' && match.job?.hasExam && (
        <Badge variant="outline" className="bg-purple-50 text-purple-600 border-purple-200">
          📝 Has Exam
        </Badge>
      )}
      
      <Badge variant="secondary" className="bg-green-100 text-green-800">
        {match.matchScore} match
      </Badge>
      
      <Badge className={getStatusColor(match.status)}>
        {getStatusIcon(match.status)}
        <span className="ml-1 capitalize">{match.status}</span>
      </Badge>
    </div>
  );
}

// Job match details component
function JobMatchDetails({ match, formatSalary }: { match: any; formatSalary: (min?: number, max?: number) => string }) {
  return (
    <div className="flex items-center space-x-4 text-sm text-slate-500 mb-4 flex-wrap gap-2">
      <div className="flex items-center space-x-1">
        <MapPin className="w-4 h-4" />
        <span>{match.job?.location || 'Location Unavailable'}</span>
      </div>
      <div className="flex items-center space-x-1">
        <DollarSign className="w-4 h-4" />
        <span>{formatSalary(match.job?.salaryMin, match.job?.salaryMax)}</span>
      </div>
      <Badge variant="outline" className="text-xs">
        {match.job?.workType || 'Remote'}
      </Badge>
    </div>
  );
}

// Job match actions component
function JobMatchActions({ match, onTakeExam, onApply, onStartChat, onMarkApplied, timeAgo }: { match: any; onTakeExam: (jobId: number, title: string) => void; onApply: (jobId: number) => void; onStartChat: (jobId: number) => void; onMarkApplied: (matchId: number) => void; timeAgo: (date: string) => string }) {
  return (
    <div className="flex-shrink-0 text-right">
      <div className="flex flex-col space-y-2 mb-3">
        {match.job?.source === 'internal' ? (
          <InternalJobActions 
            match={match}
            onTakeExam={onTakeExam}
            onApply={onApply}
            onStartChat={onStartChat}
          />
        ) : (
          <ExternalJobActions 
            match={match}
            onMarkApplied={onMarkApplied}
          />
        )}
      </div>
      <p className="text-xs text-slate-400">
        Matched {new Date(match.createdAt).toLocaleDateString()}
      </p>
    </div>
  );
}

// Internal job actions
function InternalJobActions({ match, onTakeExam, onApply, onStartChat }: { match: any; onTakeExam: (jobId: number, title: string) => void; onApply: (jobId: number) => void; onStartChat: (jobId: number) => void }) {
  return (
    <>
      {match.job?.hasExam && match.status === 'pending' && (
        <Button
          size="sm"
          onClick={() => onTakeExam(match.job.id, match.job.title)}
          className="bg-purple-600 hover:bg-purple-700"
        >
          <BookOpen className="w-4 h-4 mr-1" />
          Take Exam
        </Button>
      )}
      
      {match.status === 'pending' && !match.job?.hasExam && (
        <Button
          size="sm"
          onClick={() => onApply(match.job.id)}
        >
          Apply Now
        </Button>
      )}
      
      {(match.status === 'applied' || match.status === 'exam_completed') && (
        <Button size="sm" variant="outline" disabled>
          Awaiting Review
        </Button>
      )}
      
      {(match.status === 'screening' || match.status === 'interview') && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onStartChat(match.job.id)}
        >
          <MessageSquare className="w-4 h-4 mr-1" />
          Chat with Hiring Manager
        </Button>
      )}
    </>
  );
}

// External job actions
function ExternalJobActions({ match, onMarkApplied }: { match: any; onMarkApplied: (matchId: number) => void }) {
  // Check localStorage for applied status
  const getAppliedJobs = () => {
    if (typeof window === 'undefined') {return new Set();}
    const stored = localStorage.getItem(`appliedJobs_${match.candidateId}`);
    return new Set(stored ? JSON.parse(stored) : []);
  };

  const isJobApplied = (jobId: number | string) => {
    return getAppliedJobs().has(jobId.toString());
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => window.open(match.job?.externalUrl || match.job?.careerPageUrl, '_blank')}
      >
        <ExternalLink className="w-4 h-4 mr-1" />
        View Job
      </Button>
      <Button
        size="sm"
        onClick={() => onMarkApplied(match.id)}
        disabled={match.status === 'applied' || isJobApplied(match.id)}
      >
        {match.status === 'applied' || isJobApplied(match.id) ? 'Applied' : 'Mark Applied'}
      </Button>
    </>
  );
}

// Application card component
export function ApplicationCard({ application, getStatusColor, getStatusIcon, timeAgo }: { application: any; getStatusColor: (status: string) => string; getStatusIcon: (status: string) => JSX.Element; timeAgo: (date: string) => string }) {
  return (
    <div className="flex items-center justify-between p-4 border border-slate-200 rounded-lg hover:shadow-sm transition-shadow">
      <div className="flex-1">
        <h3 className="font-medium text-slate-900">{application.job?.title || 'Job Title Unavailable'}</h3>
        <p className="text-sm text-slate-500">{application.job?.company || 'Company'} • {application.job?.location || 'Location'}</p>
      </div>
      <div className="flex items-center space-x-3">
        <Badge className={getStatusColor(application.status)}>
          {getStatusIcon(application.status)}
          <span className="ml-1 capitalize">{application.status}</span>
        </Badge>
        <span className="text-xs text-slate-400">
          {timeAgo(application.appliedAt)}
        </span>
      </div>
    </div>
  );
}

// Activity item component
export function ActivityItem({ activity, timeAgo }: { activity: any; timeAgo: (date: string) => string }) {
  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'job_match':
        return <Star className="w-4 h-4 text-blue-500" />;
      case 'job_applied':
        return <Briefcase className="w-4 h-4 text-green-500" />;
      case 'exam_completed':
        return <BookOpen className="w-4 h-4 text-purple-500" />;
      default:
        return <Clock className="w-4 h-4 text-slate-500" />;
    }
  };

  return (
    <div className="flex items-start space-x-3 p-3 rounded-lg hover:bg-slate-50 transition-colors">
      <div className="flex-shrink-0 mt-1">
        {getActivityIcon(activity.type)}
      </div>
      <div className="flex-1">
        <p className="text-sm text-slate-900">{activity.description}</p>
        <p className="text-xs text-slate-500 mt-1">{timeAgo(activity.createdAt)}</p>
      </div>
    </div>
  );
}

// Empty state component
export function EmptyState({ 
  icon: Icon, 
  title, 
  description, 
  children 
}: { 
  icon: any; 
  title: string; 
  description: string; 
  children?: React.ReactNode;
}) {
  return (
    <div className="text-center py-8">
      <Icon className="w-12 h-12 text-slate-400 mx-auto mb-4" />
      <h3 className="text-lg font-medium text-slate-900 mb-2">{title}</h3>
      <p className="text-slate-500 mb-4">{description}</p>
      {children}
    </div>
  );
}

// Loading skeleton component
export function LoadingSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="animate-pulse">
          <div className="h-24 bg-slate-200 rounded-lg"></div>
        </div>
      ))}
    </div>
  );
}