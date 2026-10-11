import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Edit, Pause, Users, Loader2 } from "lucide-react";

interface JobCardProps {
  job: any;
  onEdit?: (job: any) => void;
  onViewMatches?: (job: any) => void;
}

interface Match {
  status: string;
}

export default function JobCard({ job, onEdit, onViewMatches }: JobCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: matches = [], isLoading: matchesLoading } = useQuery<Match[]>({
    queryKey: ["/api/jobs", job.id, "matches"],
  });

  const updateJobMutation = useMutation({
    mutationFn: async (updates: any) => {
      await apiRequest('PATCH', `/api/jobs/${job.id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      toast({
        title: "Job Updated",
        description: "Job posting has been updated successfully.",
      });
    },
  });

  const _getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-secondary text-white';
      case 'paused': return 'bg-yellow-500 text-white';
      case 'closed': return 'bg-gray-500 text-white';
      default: return 'bg-gray-500 text-white';
    }
  };

  const getStatusDot = (status: string) => {
    switch (status) {
      case 'active': return 'bg-secondary';
      case 'paused': return 'bg-yellow-500';
      case 'closed': return 'bg-gray-500';
      default: return 'bg-gray-500';
    }
  };

  const toggleJobStatus = () => {
    const newStatus = job.status === 'active' ? 'paused' : 'active';
    updateJobMutation.mutate({ status: newStatus });
  };

  const interestedCount = matches.filter((m: any) => m.status === 'interested').length;
  const interviewingCount = matches.filter((m: any) => m.status === 'interviewing').length;

  return (
    <Card className="border border-gray-200">
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h4 className="text-lg font-semibold text-neutral-800">{job.title}</h4>
            <p className="text-neutral-600">
              {job.workType} • {job.location} • 
              {job.salaryMin && job.salaryMax && (
                ` $${(job.salaryMin / 1000).toFixed(0)}k-$${(job.salaryMax / 1000).toFixed(0)}k`
              )}
            </p>
            <div className="flex items-center space-x-4 mt-2 text-sm text-neutral-600">
              {(job as any).postedAt
                ? <span>Posted {new Date((job as any).postedAt).toLocaleDateString()}</span>
                : <span>First seen {new Date(job.createdAt).toLocaleDateString()}</span>}
              <span className="flex items-center space-x-1">
                <div className={`w-2 h-2 rounded-full ${getStatusDot(job.status)}`}></div>
                <span className="capitalize">{job.status}</span>
              </span>
            </div>
          </div>
          <div className="flex space-x-2">
            <Button variant="ghost" size="sm" onClick={() => onEdit?.(job)} title="Edit job">
              <Edit className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleJobStatus} disabled={updateJobMutation.isPending} title={job.status === 'active' ? 'Pause job' : 'Activate job'}>
              {updateJobMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Pause className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center p-3 bg-neutral-50 rounded-lg">
            <div className="text-xl font-bold text-primary">
              {matchesLoading ? "..." : matches.length}
            </div>
            <div className="text-sm text-neutral-600">New Matches</div>
          </div>
          <div className="text-center p-3 bg-neutral-50 rounded-lg">
            <div className="text-xl font-bold text-secondary">
              {matchesLoading ? "..." : interestedCount}
            </div>
            <div className="text-sm text-neutral-600">Interested</div>
          </div>
          <div className="text-center p-3 bg-neutral-50 rounded-lg">
            <div className="text-xl font-bold text-yellow-600">
              {matchesLoading ? "..." : interviewingCount}
            </div>
            <div className="text-sm text-neutral-600">Interviewing</div>
          </div>
        </div>

        <div className="flex space-x-3">
          <Button className="flex-1" disabled={matches.length === 0} onClick={() => onViewMatches?.(job)}>
            <Users className="h-4 w-4 mr-2" />
            View Matches ({matches.length})
          </Button>
          <Button variant="outline" onClick={() => onEdit?.(job)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit Job
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
