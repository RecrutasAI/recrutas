import { useState, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient, fetchProfileWithCache } from '@/lib/queryClient';
import { useGuidedSetup } from '@/contexts/GuidedSetupContext';
import { Progress } from '@/components/ui/progress';
import { Loader2, Upload, CheckCircle, AlertCircle, FileText, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { track } from '@/lib/analytics';

interface ResumeProcessingResult {
  resumeUrl: string;
  parsed: boolean;
  aiParsing: {
    success: boolean;
    confidence: number;
    processingTime: number;
  };
  extractedInfo: {
    skillsCount: number;
    softSkillsCount: number;
    experience: string;
    workHistoryCount: number;
    educationCount: number;
    certificationsCount: number;
    projectsCount: number;
    hasContactInfo: boolean;
    extractedName: string;
    extractedLocation: string;
    linkedinFound: boolean;
    githubFound: boolean;
  } | null;
  autoMatchingTriggered: boolean;
}

export default function ResumeUploadStep() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'parsing' | 'polling' | 'complete' | 'error'>('idle');
  const [pollingMessage, setPollingMessage] = useState('');
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingStartRef = useRef<number>(0);
  const { toast } = useToast();
  const { setStep } = useGuidedSetup();

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // Start polling for resume processing status
  const startPolling = () => {
    setUploadPhase('polling');
    setPollingMessage('Analyzing resume with AI...');
    pollingStartRef.current = Date.now();

    pollingIntervalRef.current = setInterval(async () => {
      try {
        // fetchProfileWithCache, not a raw fetch: /api/candidate/profile answers
        // `{ exists, profile }`, so reading status off the raw body always gave
        // undefined. The 'completed' and 'failed' branches below could never
        // fire, and every successful upload sat here until the 60s timeout and
        // was then reported as "taking longer than expected".
        const profile = await fetchProfileWithCache();

        const elapsed = Date.now() - pollingStartRef.current;
        const seconds = Math.floor(elapsed / 1000);

        if (profile?.resumeProcessingStatus === 'completed') {
          // Success! Stop polling and refresh data
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
          }
          setUploadPhase('complete');
          setUploadProgress(100);

          // Invalidate queries to refresh job feed with new matches
          queryClient.invalidateQueries({ queryKey: ['/api/ai-matches'] });
          queryClient.invalidateQueries({ queryKey: ['/api/candidate/profile'] });
          queryClient.invalidateQueries({ queryKey: ['user'] });

          toast({
            title: 'Resume Analyzed Successfully',
            description: 'Your skills have been extracted and job matches are ready!',
          });

          // Proceed to next step after short delay
          setTimeout(() => {
            setStep((prev) => prev + 1);
          }, 1500);

        } else if (profile?.resumeProcessingStatus === 'failed') {
          // Processing failed
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
          }
          setUploadPhase('complete'); // Still allow continuing
          toast({
            title: 'Resume Processing Issue',
            description: 'We had trouble analyzing your resume. You can add skills manually.',
            variant: 'destructive',
          });
          setTimeout(() => {
            setStep((prev) => prev + 1);
          }, 2000);

        } else if (elapsed > 60000) {
          // Timeout after 60 seconds
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
          }
          setUploadPhase('complete');
          toast({
            title: 'Processing Taking Longer Than Expected',
            description: 'Your resume was uploaded. Processing will continue in the background.',
          });
          setTimeout(() => {
            setStep((prev) => prev + 1);
          }, 1500);

        } else {
          // Still processing - update message
          setPollingMessage(`Analyzing resume with AI... (${seconds}s)`);
          setUploadProgress(70 + Math.min(25, seconds)); // Progress from 70 to 95
        }
      } catch (error) {
        console.error('Polling error:', error);
        // Don't stop polling on transient errors, just log
      }
    }, 3000); // Poll every 3 seconds
  };

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      setUploadPhase('uploading');
      setUploadProgress(20);

      // Simulate progress while uploading
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 50));
      }, 300);

      try {
        const response = await apiRequest('POST', '/api/candidate/resume', formData);

        clearInterval(progressInterval);
        setUploadPhase('parsing');
        setUploadProgress(70);

        const data = await response.json();

        setUploadProgress(100);
        setUploadPhase('complete');

        return data as ResumeProcessingResult;
      } catch (error) {
        clearInterval(progressInterval);
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/candidate/profile'] });

      track('resume_uploaded', {
        parsed: data.parsed,
        skills_count: data.extractedInfo?.skillsCount ?? 0,
        ai_confidence: data.aiParsing?.confidence,
        work_history_count: data.extractedInfo?.workHistoryCount ?? 0,
      });

      // Check if immediate parsing completed or if we need to poll
      if (data.parsed && data.extractedInfo && data.extractedInfo.skillsCount > 0) {
        // Parsing completed synchronously with good results
        setUploadPhase('complete');
        setUploadProgress(100);
        toast({
          title: 'Resume Uploaded & Parsed',
          description: `Extracted ${data.extractedInfo.skillsCount} skills and ${data.extractedInfo.workHistoryCount} work experiences.`,
        });

        // Refresh job matches
        queryClient.invalidateQueries({ queryKey: ['/api/ai-matches'] });

        // Short delay to show success state before proceeding
        setTimeout(() => {
          setStep((prev) => prev + 1);
        }, 1000);
      } else {
        // Start polling for background processing completion
        startPolling();
      }
    },
    onError: (error: any) => {
      console.error('Resume upload failed:', error);
      setUploadPhase('error');
      setUploadProgress(0);

      const errorMessage = error?.message || 'Failed to upload your resume. Please try again.';
      toast({
        title: 'Upload Failed',
        description: errorMessage,
        variant: 'destructive',
      });
    },
  });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      const selectedFile = event.target.files[0];

      // Validate file type
      const validTypes = ['.pdf', '.doc', '.docx'];
      const fileExtension = selectedFile.name.toLowerCase().substring(selectedFile.name.lastIndexOf('.'));

      if (!validTypes.includes(fileExtension)) {
        toast({
          title: 'Invalid File Type',
          description: 'Please upload a PDF or Word document (.pdf, .doc, .docx)',
          variant: 'destructive',
        });
        return;
      }

      // Validate file size (4MB max)
      if (selectedFile.size > 4 * 1024 * 1024) {
        toast({
          title: 'File Too Large',
          description: 'Please upload a file smaller than 4MB',
          variant: 'destructive',
        });
        return;
      }

      setFile(selectedFile);
      setUploadPhase('idle');
      setUploadProgress(0);
    }
  };

  const handleUpload = () => {
    if (file) {
      const formData = new FormData();
      formData.append('resume', file);
      uploadMutation.mutate(formData);
    }
  };

  const handleSkip = () => {
    toast({
      title: 'Skipped Resume Upload',
      description: 'You can always upload your resume later from your profile.',
    });
    setStep((prev) => prev + 1);
  };

  const getPhaseMessage = () => {
    switch (uploadPhase) {
      case 'uploading':
        return 'Uploading your resume...';
      case 'parsing':
        return 'Processing your resume...';
      case 'polling':
        return pollingMessage || 'Analyzing resume with AI...';
      case 'complete':
        return 'Resume processed successfully!';
      case 'error':
        return 'Upload failed. Please try again.';
      default:
        return '';
    }
  };

  return (
    <div className="text-center max-w-md mx-auto">
      <div className="mb-6">
        <FileText className="h-16 w-16 mx-auto text-primary mb-4" />
        <h2 className="text-2xl font-bold mb-2">Upload Your Resume</h2>
        <p className="text-muted-foreground">
          Upload your resume and our AI will extract your skills, experience, and work history to help find the best job matches.
        </p>
      </div>

      <div className="space-y-4">
        {/* File Input */}
        <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 hover:border-primary transition-colors">
          <Input
            type="file"
            onChange={handleFileChange}
            accept=".pdf,.doc,.docx"
            className="cursor-pointer"
            disabled={uploadMutation.isPending}
          />
          <p className="text-xs text-muted-foreground mt-2">
            Supported: PDF, DOC, DOCX (max 4MB)
          </p>
        </div>

        {/* Selected File Display */}
        {file && uploadPhase === 'idle' && (
          <Alert>
            <FileText className="h-4 w-4" />
            <AlertDescription>
              Selected: <span className="font-medium">{file.name}</span> ({(file.size / 1024).toFixed(1)} KB)
            </AlertDescription>
          </Alert>
        )}

        {/* Progress Display */}
        {(uploadMutation.isPending || uploadPhase === 'polling') && (
          <div className="space-y-3">
            <Progress value={uploadProgress} className="h-2" />
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              {uploadPhase === 'polling' ? (
                <Sparkles className="h-4 w-4 animate-pulse text-blue-500" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {getPhaseMessage()}
            </div>
          </div>
        )}

        {/* Success State */}
        {uploadPhase === 'complete' && (
          <Alert className="bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700 dark:text-green-400">
              {getPhaseMessage()}
            </AlertDescription>
          </Alert>
        )}

        {/* Error State */}
        {uploadPhase === 'error' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {getPhaseMessage()}
            </AlertDescription>
          </Alert>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col gap-2">
          <Button
            onClick={handleUpload}
            disabled={!file || uploadMutation.isPending || uploadPhase === 'polling' || uploadPhase === 'complete'}
            className="w-full"
            size="lg"
          >
            {uploadMutation.isPending || uploadPhase === 'polling' ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {uploadPhase === 'polling' ? 'Analyzing...' : 'Processing...'}
              </>
            ) : uploadPhase === 'complete' ? (
              <>
                <CheckCircle className="mr-2 h-4 w-4" />
                Done!
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Upload and Continue
              </>
            )}
          </Button>

          {!uploadMutation.isPending && uploadPhase !== 'complete' && uploadPhase !== 'polling' && (
            <Button
              variant="ghost"
              onClick={handleSkip}
              className="text-muted-foreground"
            >
              Skip for now
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
