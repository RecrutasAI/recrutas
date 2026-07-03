import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Clock, CheckCircle, AlertCircle, AlertTriangle, Trophy, XCircle, Shield, Monitor, EyeOff } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { track } from '@/lib/analytics';

interface ExamQuestion {
  id: string;
  type: 'multiple-choice' | 'short-answer';
  question: string;
  options?: string[];
  points: number;
  correctAnswer?: number;
}

interface JobExam {
  id: number;
  jobId: number;
  title: string;
  jobTitle?: string;
  company?: string;
  maxChatCandidates?: number;
  questions: ExamQuestion[];
  timeLimit: number;
  passingScore: number;
}

interface JobExamProps {
  jobId: number;
  onComplete: (score: number, passed: boolean, ranking?: number, totalCandidates?: number, qualifiedForChat?: boolean, examFeedback?: string) => void;
  onCancel: () => void;
}

export function JobExam({ jobId, onComplete, onCancel }: JobExamProps) {
  const [exam, setExam] = useState<JobExam | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [result, setResult] = useState<{ score: number; passed: boolean; alreadySubmitted?: boolean; ranking?: number; totalCandidates?: number; qualifiedForChat?: boolean; examFeedback?: string } | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenSupported = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  const [violationCount, setViolationCount] = useState(0);
  const [showWarning, setShowWarning] = useState(false);
  const [examStarted, setExamStarted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Ref-based count avoids stale closure: handleViolation doesn't need violationCount
  // in its deps, so event listeners aren't re-registered on every violation.
  const violationCountRef = useRef(0);
  // Stable ref ensures handleViolation and the timer always call the current submit fn.
  const submitExamRef = useRef<() => void>(() => {});
  const hasSubmittedRef = useRef(false);
  const { toast } = useToast();

  const maxViolations = 3;

  const requestFullscreen = useCallback(async () => {
    try {
      if (containerRef.current) {
        await containerRef.current.requestFullscreen();
      }
    } catch (err) {
      console.log('Fullscreen request failed:', err);
    }
  }, []);

  const handleViolation = useCallback((type: string) => {
    violationCountRef.current += 1;
    const newCount = violationCountRef.current;
    setViolationCount(newCount);
    setShowWarning(true);

    toast({
      title: "Exam Violation Detected",
      description: `${type}. This is warning ${newCount} of ${maxViolations}. Too many violations will auto-submit your exam.`,
      variant: "destructive",
    });

    if (newCount >= maxViolations) {
      toast({
        title: "Exam Auto-Submitted",
        description: "Too many violations detected. Your exam has been automatically submitted.",
        variant: "destructive",
      });
      setTimeout(() => submitExamRef.current(), 1000);
    }

    setTimeout(() => setShowWarning(false), 3000);
  }, [toast]);

  useEffect(() => {
    if (!examStarted) {return;}

    const handleVisibilityChange = () => {
      if (document.hidden) {
        handleViolation("You left the exam tab");
      }
    };

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement && examStarted) {
        handleViolation("You exited fullscreen mode");
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      handleViolation("Right-click is disabled during the exam");
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x' || e.key === 'u')) {
        e.preventDefault();
        handleViolation("Copy/Paste keyboard shortcuts are disabled");
      }
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        handleViolation("Screenshot key is disabled");
      }
      if (e.key === 'Escape' && isFullscreen) {
        handleViolation("ESC key is disabled during the exam");
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (fullscreenSupported) {
      document.addEventListener('fullscreenchange', handleFullscreenChange);
    }
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (fullscreenSupported) {
        document.removeEventListener('fullscreenchange', handleFullscreenChange);
      }
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [examStarted, isFullscreen, handleViolation, fullscreenSupported]);

  const startExam = async () => {
    if (fullscreenSupported) {
      await requestFullscreen();
    }
    setExamStarted(true);
  };

  // Fetch exam data
  useEffect(() => {
    const fetchExam = async () => {
      try {
        const response = await apiRequest('GET', `/api/jobs/${jobId}/exam`);
        const examData = await response.json();
        setExam(examData);
        setTimeRemaining(examData.timeLimit * 60);
      } catch (_error) {
        toast({
          title: "Error",
          description: "Failed to load exam",
          variant: "destructive",
        });
      }
    };

    fetchExam();
  }, [jobId, toast]);

  // Timer countdown
  useEffect(() => {
    if (!exam || timeRemaining <= 0) {return;}

    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          submitExamRef.current();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [!!exam]);

  const submitExamMutation = useMutation({
    mutationFn: async (examAnswers: Record<string, string>) => {
      const response = await apiRequest('POST', `/api/jobs/${jobId}/exam/submit`, {
        answers: examAnswers
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const err: any = new Error(data.message || 'Exam submission failed');
        err.status = response.status;
        throw err;
      }
      return response.json();
    },
    onSuccess: (data) => {
      track('exam_submitted', {
        job_id: jobId,
        score: data.score,
        passed: data.passed,
        ranking: data.ranking,
        qualified_for_chat: data.qualifiedForChat,
      });
      setResult({
        score: data.score,
        passed: data.passed,
        ranking: data.ranking,
        totalCandidates: data.totalCandidates,
        qualifiedForChat: data.qualifiedForChat,
        examFeedback: data.examFeedback,
      });
    },
    onError: (error: any) => {
      setIsSubmitting(false);
      if (error.status === 409) {
        setResult({ score: 0, passed: false, alreadySubmitted: true });
        return;
      }
      toast({
        title: "Submission Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmitExam = () => {
    if (hasSubmittedRef.current || isSubmitting) {return;}
    hasSubmittedRef.current = true;
    setIsSubmitting(true);
    submitExamMutation.mutate(answers);
  };
  // Keep ref current so handleViolation and timer always call the latest version.
  submitExamRef.current = handleSubmitExam;

  const handleAnswerChange = (questionId: string, answer: string) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: answer
    }));
  };

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const getProgress = () => {
    if (!exam) {return 0;}
    const answered = Object.keys(answers).length;
    return (answered / exam.questions.length) * 100;
  };

  if (result) {
    if (result.alreadySubmitted) {
      return (
        <Card className="max-w-2xl mx-auto">
          <CardContent className="p-10 text-center space-y-6">
            <CheckCircle className="w-16 h-16 text-blue-500 mx-auto" />
            <div>
              <h2 className="text-2xl font-bold mb-2">Already Completed</h2>
              <p className="text-slate-500">You've already submitted this exam. Check your application status in the dashboard.</p>
            </div>
            <Button onClick={() => onComplete(0, false)} className="w-full max-w-xs">
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      );
    }

    const showRanking = result.ranking && result.totalCandidates;

    return (
      <Card className="max-w-2xl mx-auto">
        <CardContent className="p-10 text-center space-y-6">
          {result.passed ? (
            <Trophy className="w-16 h-16 text-green-500 mx-auto" />
          ) : (
            <XCircle className="w-16 h-16 text-red-500 mx-auto" />
          )}
          <div>
            <h2 className="text-2xl font-bold mb-2">
              {result.passed ? "You Passed!" : "Not Quite"}
            </h2>
            <p className="text-4xl font-bold mb-1">
              {result.score}<span className="text-xl font-normal text-slate-500">%</span>
            </p>
            <p className="text-slate-500">
              {result.passed
                ? "Great work! Your application has advanced."
                : `Passing score was ${exam?.passingScore ?? 70}%. Keep practicing!`}
            </p>
            {showRanking && (
              <div className="mt-4 p-4 bg-muted rounded-lg">
                <p className="text-lg font-semibold">
                  Your Ranking: #{result.ranking} of {result.totalCandidates} candidates
                </p>
                {result.qualifiedForChat && (
                  <p className="text-green-600 mt-2">
                    🎉 You're in the top {exam?.maxChatCandidates || 5}! You can now chat with the hiring manager.
                  </p>
                )}
              </div>
            )}
          </div>
          <Button onClick={() => onComplete(result.score, result.passed, result.ranking, result.totalCandidates, result.qualifiedForChat, result.examFeedback)} className="w-full max-w-xs">
            Back to Dashboard
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!exam) {
    return (
      <Card className="max-w-2xl mx-auto">
        <CardContent className="p-8 text-center">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p>Loading exam...</p>
        </CardContent>
      </Card>
    );
  }

  if (!examStarted) {
    return (
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center justify-center space-x-2">
            <Shield className="w-6 h-6 text-blue-500" />
            <span>Exam Security Check</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="text-center space-y-4">
            <Monitor className="w-16 h-16 mx-auto text-blue-500" />
            <div>
              <h3 className="text-xl font-semibold mb-2">Before You Begin</h3>
              <p className="text-muted-foreground">
                This exam requires a secure testing environment. Please ensure:
              </p>
            </div>
            <ul className="text-left space-y-2 bg-muted p-4 rounded-lg">
              <li className="flex items-center space-x-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span>You are in a quiet, private location</span>
              </li>
              <li className="flex items-center space-x-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span>Close all other browser tabs and applications</span>
              </li>
              <li className="flex items-center space-x-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span>Disable any screen sharing or remote desktop</span>
              </li>
              <li className="flex items-center space-x-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span>Do not leave the exam until you submit</span>
              </li>
            </ul>
            <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border border-yellow-200 dark:border-yellow-800">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                <strong>Note:</strong> The exam will run in fullscreen mode. Any attempt to exit fullscreen,
                copy/paste, or use external resources will be recorded as a violation.
                After 3 violations, your exam will be automatically submitted.
              </p>
            </div>
          </div>
          <Button onClick={startExam} className="w-full" size="lg">
            <Monitor className="w-5 h-5 mr-2" />
            Start Exam (Enter Fullscreen)
          </Button>
        </CardContent>
      </Card>
    );
  }

  const currentQuestion = exam.questions[currentQuestionIndex];
  const isLastQuestion = currentQuestionIndex === exam.questions.length - 1;
  const allQuestionsAnswered = exam.questions.every(q => answers[q.id]);

  return (
    <div ref={containerRef} className="max-w-4xl mx-auto space-y-6">
      {/* Mobile fullscreen warning */}
      {examStarted && !fullscreenSupported && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Fullscreen mode is not supported on this device. For the best experience, use a desktop browser. Tab-switching detection is still active.
          </p>
        </div>
      )}
      {/* Warning Overlay */}
      {showWarning && (
        <div className="fixed inset-0 bg-red-500/90 z-50 flex items-center justify-center">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-red-600">
                <EyeOff className="w-6 h-6" />
                <span>Warning!</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg">
                {violationCount >= maxViolations
                  ? "Your exam has been auto-submitted due to multiple violations."
                  : `This is warning ${violationCount} of ${maxViolations}.`}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                {violationCount >= maxViolations
                  ? "Please contact support if you believe this was a mistake."
                  : "Return to the exam immediately to continue."}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Non-fullscreen warning */}
      {!isFullscreen && examStarted && (
        <div className="bg-yellow-500 text-yellow-950 px-4 py-2 rounded-lg flex items-center justify-center space-x-2">
          <EyeOff className="w-5 h-5" />
          <span className="font-medium">Please stay in fullscreen mode for the duration of the exam</span>
        </div>
      )}

      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center space-x-2">
              <AlertCircle className="w-5 h-5" />
              <span>Job Assessment</span>
            </CardTitle>
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2 text-sm">
                <Clock className="w-4 h-4" />
                <span className={timeRemaining < 300 ? "text-red-600 font-bold" : ""}>
                  {formatTime(timeRemaining)}
                </span>
              </div>
              <div className="text-sm text-slate-500">
                Question {currentQuestionIndex + 1} of {exam.questions.length}
              </div>
            </div>
          </div>
          <Progress value={getProgress()} className="mt-2" />
        </CardHeader>
      </Card>

      {/* Current Question */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {currentQuestion.question}
          </CardTitle>
          <p className="text-sm text-slate-500">
            Worth {currentQuestion.points} points
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {currentQuestion.type === 'multiple-choice' ? (
            <RadioGroup
              value={answers[currentQuestion.id] || ''}
              onValueChange={(value) => handleAnswerChange(currentQuestion.id, value)}
            >
              {currentQuestion.options?.map((option, index) => (
                <div key={index} className="flex items-center space-x-2">
                  <RadioGroupItem value={index.toString()} id={`option-${index}`} />
                  <Label htmlFor={`option-${index}`} className="flex-1 cursor-pointer">
                    {option}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          ) : (
            <Textarea
              placeholder="Enter your answer here..."
              value={answers[currentQuestion.id] || ''}
              onChange={(e) => handleAnswerChange(currentQuestion.id, e.target.value)}
              rows={4}
            />
          )}
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          {currentQuestionIndex > 0 && (
            <Button
              variant="outline"
              onClick={() => setCurrentQuestionIndex(prev => prev - 1)}
              disabled={isSubmitting}
            >
              Previous
            </Button>
          )}
        </div>

        <div className="flex space-x-2">
          {!isLastQuestion ? (
            <Button
              onClick={() => setCurrentQuestionIndex(prev => prev + 1)}
              disabled={!answers[currentQuestion.id] || isSubmitting}
            >
              Next Question
            </Button>
          ) : (
            <Button
              onClick={handleSubmitExam}
              disabled={!allQuestionsAnswered || isSubmitting}
              className="bg-green-600 hover:bg-green-700"
            >
              {isSubmitting ? (
                <div className="flex items-center space-x-2">
                  <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                  <span>Submitting...</span>
                </div>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Submit Exam
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Question Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Question Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
            {exam.questions.map((_, index) => (
              <Button
                key={index}
                variant={index === currentQuestionIndex ? "default" : "outline"}
                size="sm"
                className={`w-8 h-8 p-0 ${
                  answers[exam.questions[index].id]
                    ? "bg-green-100 border-green-300 text-green-700 dark:bg-green-900/30 dark:border-green-700 dark:text-green-300"
                    : ""
                }`}
                onClick={() => setCurrentQuestionIndex(index)}
                disabled={isSubmitting}
              >
                {index + 1}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
