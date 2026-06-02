import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useSession } from "@supabase/auth-helpers-react";
import { apiRequest } from "@/lib/queryClient";
import { JobExam } from "@/components/job-exam";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Briefcase, Clock, CheckCircle } from "lucide-react";

export default function ExamPage() {
  const [, setLocation] = useLocation();
  const session = useSession();
  const params = useParams<{ jobId?: string }>();

  // The route is /exam/:jobId — there is no jobTitle param. Fetch the real
  // title from the exam endpoint (which the candidate is already authorized to
  // read, having applied) so the header doesn't read "Job Assessment for Job
  // Assessment".
  const jobId = params.jobId ? parseInt(params.jobId) : undefined;
  const [jobTitle, setJobTitle] = useState("Job Assessment");

  useEffect(() => {
    if (!jobId || !session?.user) {return;}
    let cancelled = false;
    (async () => {
      try {
        const response = await apiRequest('GET', `/api/jobs/${jobId}/exam`);
        const data = await response.json();
        if (!cancelled && data?.jobTitle) {setJobTitle(data.jobTitle);}
      } catch {
        // Leave the generic fallback in place if the title can't be fetched.
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, session?.user]);

  const [examStarted, setExamStarted] = useState(false);
  const [examCompleted, setExamCompleted] = useState(false);
  const [examResult, setExamResult] = useState<{ score: number; passed: boolean; ranking?: number; totalCandidates?: number; qualifiedForChat?: boolean; examFeedback?: string } | null>(null);

  const handleExamStart = () => {
    setExamStarted(true);
  };

  const handleExamComplete = (score: number, passed: boolean, ranking?: number, totalCandidates?: number, qualifiedForChat?: boolean, examFeedback?: string) => {
    setExamResult({ score, passed, ranking, totalCandidates, qualifiedForChat, examFeedback });
    setExamCompleted(true);
    setExamStarted(false);
  };

  const handleExamCancel = () => {
    setLocation('/candidate-dashboard');
  };

  const handleReturnToDashboard = () => {
    setLocation('/candidate-dashboard');
  };

  if (!session?.user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-muted-foreground">Please log in to take the exam.</p>
            <Button 
              className="mt-4" 
              onClick={() => setLocation('/auth')}
            >
              Log In
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!jobId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-muted-foreground">Invalid exam link. Please return to the job listing.</p>
            <Button 
              className="mt-4" 
              onClick={handleReturnToDashboard}
            >
              Return to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExamCancel}
                className="flex items-center space-x-1"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Jobs</span>
              </Button>
              <div className="h-6 w-px bg-muted" />
              <div className="flex items-center space-x-2">
                <Briefcase className="w-5 h-5 text-muted-foreground" />
                <h1 className="text-lg font-semibold text-foreground">{jobTitle}</h1>
              </div>
            </div>
            <Badge variant="secondary" className="flex items-center space-x-1">
              <Clock className="w-3 h-3" />
              <span>Assessment</span>
            </Badge>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!examStarted && !examCompleted && (
          <div className="space-y-6">
            {/* Exam Introduction */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Briefcase className="w-5 h-5" />
                  <span>Job Assessment for {jobTitle}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="prose prose-foreground max-w-none">
                  <p>
                    Welcome to the assessment for the <strong>{jobTitle}</strong> position. 
                    This exam will help us evaluate your skills and experience for this role.
                  </p>
                  
                  <h4>What to expect:</h4>
                  <ul>
                    <li>Multiple choice and open-ended questions</li>
                    <li>Questions specific to the job requirements</li>
                    <li>Time limit will be displayed during the exam</li>
                    <li>Your progress will be saved automatically</li>
                  </ul>
                  
                  <h4>Instructions:</h4>
                  <ul>
                    <li>Read each question carefully</li>
                    <li>You can navigate between questions</li>
                    <li>Submit when you're confident in your answers</li>
                    <li>Ensure you have a stable internet connection</li>
                  </ul>
                </div>
                
                <div className="bg-primary/10 border border-primary/20 rounded-lg p-4">
                  <p className="text-primary text-sm">
                    <strong>Note:</strong> Once you start the exam, the timer will begin. 
                    Make sure you're ready before clicking "Start Exam".
                  </p>
                </div>

                <div className="flex justify-center pt-4">
                  <Button 
                    onClick={handleExamStart}
                    className="bg-primary hover:bg-primary/90"
                    size="lg"
                  >
                    Start Exam
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {examStarted && !examCompleted && (
          <JobExam
            jobId={jobId}
            onComplete={handleExamComplete}
            onCancel={handleExamCancel}
          />
        )}

        {examCompleted && examResult && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <CheckCircle className={`w-5 h-5 ${examResult.passed ? 'text-green-500' : 'text-orange-500'}`} />
                  <span>Exam Completed</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center space-y-4">
                  <div className="space-y-2">
                    <p className="text-lg font-medium text-foreground">
                      Your Score: <span className="text-2xl font-bold">{examResult.score}%</span>
                    </p>
                    <Badge 
                      variant={examResult.passed ? "default" : "secondary"}
                      className={`text-sm px-3 py-1 ${
                        examResult.passed ? 'bg-green-500/10 text-green-500' : 'bg-orange-500/10 text-orange-500'
                      }`}
                    >
                      {examResult.passed ? '✅ Passed' : '⏳ Under Review'}
                    </Badge>
                  </div>

                  {examResult.passed ? (
                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                      <p className="text-foreground">
                        <strong>Congratulations!</strong> You've passed the assessment and unlocked direct chat with the hiring team. Expect a response within 24 hours.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="bg-muted rounded-lg p-4">
                        <p className="text-muted-foreground">
                          <strong>Thank you for completing the assessment.</strong>{' '}
                          You didn't meet the passing threshold this time.
                        </p>
                      </div>
                      {examResult.examFeedback && (
                        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-left">
                          <p className="text-sm font-semibold text-blue-600 dark:text-blue-400 mb-1">AI Feedback</p>
                          <p className="text-sm text-foreground">{examResult.examFeedback}</p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-center space-x-4">
                    <Button 
                      onClick={handleReturnToDashboard}
                      className="bg-primary hover:bg-primary/90"
                    >
                      Return to Dashboard
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
