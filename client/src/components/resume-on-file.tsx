import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertCircle, Download, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ResumeFileData {
  onFile: boolean;
  exists?: boolean;
  fileName?: string;
  contentType?: string | null;
  size?: number | null;
  uploadedAt?: string | null;
  viewUrl?: string | null;
  downloadUrl?: string | null;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * The resume on file exactly as recruiters receive it: the file the extension
 * attaches and the name it gives it. Links are short-lived, so they're fetched
 * fresh rather than cached.
 */
export function ResumeOnFile() {
  const { data } = useQuery<ResumeFileData>({ queryKey: ["/api/candidate/resume-file"], staleTime: 0, gcTime: 60_000 });
  if (!data?.onFile) {return null;}
  if (!data.exists) {
    return (
      <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30" data-testid="resume-missing">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
        <p className="text-sm text-amber-800 dark:text-amber-200">Your resume file is missing. Upload it again so the extension can attach it.</p>
      </div>
    );
  }
  const details = [
    data.uploadedAt ? `uploaded ${format(new Date(data.uploadedAt), "MMM d")}` : null,
    data.size ? kb(data.size) : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900" data-testid="resume-on-file">
      <div className="flex items-center gap-2 min-w-0">
        <FileText className="h-5 w-5 shrink-0 text-emerald-600" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate" data-testid="resume-file-name">{data.fileName}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {details}{details ? " · " : ""}this is the file and name recruiters receive
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        {data.viewUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={data.viewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4 mr-1" />View</a>
          </Button>
        )}
        {data.downloadUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={data.downloadUrl} download={data.fileName}><Download className="h-4 w-4 mr-1" />Download</a>
          </Button>
        )}
      </div>
    </div>
  );
}
