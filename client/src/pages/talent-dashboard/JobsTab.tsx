import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Plus, Users, Briefcase, MapPin, DollarSign,
  Search, Eye, Clock, Edit, Trash2, Building2, ChevronRight
} from "lucide-react";
import type { JobPosting, TabName } from "./types";

interface JobsTabProps {
  jobs: JobPosting[];
  jobsLoading: boolean;
  filteredJobs: JobPosting[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  filterStatus: string;
  setFilterStatus: (s: string) => void;
  setSelectedJob: (job: JobPosting | null) => void;
  setJobForm: (fn: (prev: any) => any) => void;
  setShowJobDialog: (open: boolean) => void;
  setShowJobWizard: (open: boolean) => void;
  setJobToDelete: (job: JobPosting | null) => void;
  setActiveTab: (tab: TabName) => void;
}

function statusBadgeClass(status: string) {
  if (status === 'active') return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800 hover:bg-emerald-50";
  if (status === 'paused') return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800 hover:bg-amber-50";
  return "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700 hover:bg-gray-100";
}

export default function JobsTab({
  jobs,
  jobsLoading,
  filteredJobs,
  searchQuery,
  setSearchQuery,
  filterStatus,
  setFilterStatus,
  setSelectedJob,
  setJobForm,
  setShowJobDialog,
  setShowJobWizard,
  setJobToDelete,
  setActiveTab,
}: JobsTabProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Job Postings</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {jobs.length} {jobs.length === 1 ? 'posting' : 'postings'} total
          </p>
        </div>
        <Button
          onClick={() => setShowJobWizard(true)}
          className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shrink-0"
        >
          <Plus className="h-4 w-4 mr-2" />
          Post New Job
        </Button>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search by title or company..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 rounded-lg h-9 text-sm"
          />
        </div>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-full sm:w-44 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 rounded-lg h-9 text-sm">
            <SelectValue placeholder="All status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Jobs List */}
      {jobsLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 animate-pulse">
              <div className="h-5 bg-gray-100 dark:bg-gray-800 rounded w-1/3 mb-3" />
              <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded w-1/2 mb-4" />
              <div className="flex gap-2">
                <div className="h-5 w-16 bg-gray-100 dark:bg-gray-800 rounded-full" />
                <div className="h-5 w-20 bg-gray-100 dark:bg-gray-800 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-12 text-center">
          <div className="h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
            <Briefcase className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">
            {searchQuery || filterStatus !== 'all' ? 'No jobs match your filters' : 'No job postings yet'}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
            {searchQuery || filterStatus !== 'all'
              ? 'Try adjusting your search or filters'
              : 'Create your first job posting to start finding great candidates'}
          </p>
          {!searchQuery && filterStatus === 'all' && (
            <Button
              size="sm"
              onClick={() => setShowJobWizard(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Post a Job
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredJobs.map((job) => (
            <div key={job.id} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Title row */}
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white">{job.title}</h3>
                    <Badge variant="outline" className={statusBadgeClass(job.status)}>
                      {job.status}
                    </Badge>
                  </div>

                  {/* Meta row */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400 mb-3">
                    <span className="flex items-center gap-1">
                      <Building2 className="h-3.5 w-3.5" />
                      {job.company}
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {job.location}
                    </span>
                    {(job.salaryMin || job.salaryMax) && (
                      <span className="flex items-center gap-1">
                        <DollarSign className="h-3.5 w-3.5" />
                        {job.salaryMin && job.salaryMax
                          ? `${job.salaryMin.toLocaleString()} to ${job.salaryMax.toLocaleString()}`
                          : job.salaryMin
                            ? `From ${job.salaryMin.toLocaleString()}`
                            : `Up to ${job.salaryMax?.toLocaleString()}`}
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2 mb-3">
                    {job.description}
                  </p>

                  {/* Skills */}
                  {job.skills && job.skills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {job.skills.slice(0, 4).map((skill, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                        >
                          {skill}
                        </span>
                      ))}
                      {job.skills.length > 4 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          +{job.skills.length - 4}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-xs text-gray-400 dark:text-gray-500">
                    <span className="flex items-center gap-1">
                      <Eye className="h-3.5 w-3.5" />
                      {job.viewCount} views
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {job.applicationCount} applicants
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {new Date(job.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex lg:flex-col gap-2 shrink-0">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 lg:flex-none border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-xs"
                          onClick={() => {
                            setSelectedJob(job);
                            setActiveTab('candidates');
                          }}
                        >
                          <Users className="h-3.5 w-3.5 mr-1.5" />
                          Applicants
                          <ChevronRight className="h-3 w-3 ml-1" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>View applicants for this job</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 lg:flex-none border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-xs"
                          onClick={() => {
                            setSelectedJob(job);
                            setJobForm((prev: any) => ({
                              ...prev,
                              title: job.title,
                              company: job.company,
                              description: job.description,
                              requirements: job.requirements,
                              skills: job.skills,
                              location: job.location,
                              salaryMin: job.salaryMin?.toString() || "",
                              salaryMax: job.salaryMax?.toString() || "",
                              workType: job.workType,
                            }));
                            setShowJobDialog(true);
                          }}
                        >
                          <Edit className="h-3.5 w-3.5 mr-1.5" />
                          Edit
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit this job posting</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 lg:flex-none border-gray-200 dark:border-gray-700 hover:bg-red-50 dark:hover:bg-red-950 text-red-500 hover:text-red-600 hover:border-red-200 dark:hover:border-red-800 text-xs"
                          onClick={() => setJobToDelete(job)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                          Delete
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete this job posting</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
