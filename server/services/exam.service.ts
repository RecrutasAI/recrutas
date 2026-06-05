import { IStorage } from "../storage";
import { callAI, isAIAvailable } from "../lib/ai-client";
import { track } from "../lib/analytics";

// Interface for notification service to avoid circular dependency
interface INotificationService {
  notifyExamCompleted(talentOwnerId: string, candidateName: string, jobTitle: string, score: number, applicationId: number, passed?: boolean): Promise<void>;
  notifyCandidateExamResult(candidateId: string, jobTitle: string, score: number, passed: boolean, passingScore: number, applicationId: number, examFeedback?: string, company?: string, ranking?: number, totalCandidates?: number): Promise<void>;
}

class ExamProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExamProcessingError";
  }
}

export class ExamService {
  constructor(private storage: IStorage, private notificationService: INotificationService) {}

  async submitExam(jobId: number, userId: string, answers: any): Promise<{ score: number; passed: boolean; ranking: number; totalCandidates: number; qualifiedForChat: boolean; examFeedback?: string; responseDeadlineAt?: string }> {
    console.log(`[ExamService] Submitting exam for job ${jobId} and user ${userId}`);

    try {
      const job = await this.storage.getJobPosting(jobId);
      if (!job) {
        throw new ExamProcessingError("Job not found");
      }

      const exam = await this.storage.getJobExam(jobId);
      if (!exam) {
        throw new ExamProcessingError("Exam not found for this job");
      }

      const { score, correctAnswers } = await this.calculateScoreWithDetails(exam.questions, answers, {
        title: job.title,
        description: job.description || undefined
      });

      const passingScore = exam.passingScore || 70;
      const passed = score >= passingScore;

      // Generate AI feedback for failed candidates (non-blocking — best effort)
      let examFeedback: string | undefined;
      if (!passed && isAIAvailable()) {
        try {
          const skillList = Array.isArray(job.skills) ? (job.skills as string[]).slice(0, 6).join(', ') : '';
          const feedbackPrompt = `A candidate scored ${score}% (passing: ${passingScore}%) on a "${job.title}" technical assessment. They answered ${correctAnswers} of ${exam.questions.length} questions correctly.${skillList ? ` Skills assessed: ${skillList}.` : ''}\n\nWrite 2–3 sentences of specific, actionable feedback: what they showed strength in, what to improve, and one concrete next step. Be direct and encouraging. Under 80 words.`;
          examFeedback = await Promise.race([
            callAI('You are a helpful hiring coach giving exam feedback.', feedbackPrompt, { priority: 'high', estimatedTokens: 300, temperature: 0.4, maxOutputTokens: 120 }),
            new Promise<string>((resolve) => setTimeout(() => resolve(''), 8000)),
          ]) || undefined;
        } catch {
          // Feedback is best-effort — never block exam submission
        }
      }

      const responseDeadlineAt = passed
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : undefined;

      const examResult = {
        jobId,
        candidateId: userId,
        score,
        answers,
        totalQuestions: exam.questions.length,
        correctAnswers,
        timeSpent: 0,
        examFeedback: examFeedback ?? null,
      };

      await this.storage.storeExamResult(examResult);
      console.log(`[ExamService] Exam result stored for job ${jobId} and user ${userId}`);

      track(userId, 'exam_graded', {
        job_id: jobId,
        score,
        passed,
        passing_score: passingScore,
        correct_answers: correctAnswers,
        total_questions: exam.questions.length,
        has_feedback: !!examFeedback,
      });

      if (job.autoRankCandidates) {
        console.log(`[ExamService] Autoranking candidates for job ${jobId}`);
        await this.storage.rankCandidatesByExamScore(jobId);
      }
      
      const candidate = await this.storage.getCandidateUser(userId);
      
      // Look up the application and promote it from pending_exam → submitted
      const application = await this.storage.getApplicationByJobAndCandidate(jobId, userId);
      const applicationId = application?.id ?? 0;
      if (application?.status === 'pending_exam') {
        await this.storage.updateApplicationStatusByCandidate(applicationId, 'submitted');
      }

      const candidateName = candidate
        ? `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate'
        : 'Candidate';
      await this.notificationService.notifyExamCompleted(
        job.talentOwnerId,
        candidateName,
        job.title,
        score,
        applicationId,
        passed
      );

      await this.notificationService.notifyCandidateExamResult(
        userId,
        job.title,
        score,
        passed,
        passingScore,
        applicationId,
        examFeedback,
        job.company,
      );

      // Compute ranking against all completed attempts for this job.
      // storeExamResult() commits atomically, so the current attempt is included.
      const attempts = await this.storage.getExamAttempts(jobId);
      const sorted = attempts
        .filter((a: any) => a.status === 'completed' && a.score !== null)
        .sort((a: any, b: any) => (b.score || 0) - (a.score || 0));

      const ranking = sorted.findIndex((a: any) => a.candidateId === userId) + 1;
      const totalCandidates = sorted.length;
      const qualifiedForChat = ranking > 0 && ranking <= (job.maxChatCandidates || 5);

      return { score, passed, ranking, totalCandidates, qualifiedForChat, examFeedback, responseDeadlineAt };
    } catch (error) {
      console.error("[ExamService] Error submitting exam:", error);
      if (error instanceof ExamProcessingError) {
        throw error;
      }
      const message = (error as Error).message;
      if (message === 'Exam already submitted for this job') {
        throw new ExamProcessingError(message);
      }
      throw new ExamProcessingError("Failed to submit exam");
    }
  }

  private async calculateScore(questions: any[], answers: any): Promise<number> {
    const { score } = await this.calculateScoreWithDetails(questions, answers);
    return score;
  }

  private async calculateScoreWithDetails(questions: any[], answers: any, jobContext?: { title: string; description?: string }): Promise<{ score: number; correctAnswers: number }> {
    let earnedPoints = 0;
    let totalPoints = 0;
    let correctAnswers = 0;

    // Collect short-answer questions for batch AI scoring
    const shortAnswerQuestions: { question: any; answer: string }[] = [];

    for (const question of questions) {
      const questionPoints = question.points || 10;
      totalPoints += questionPoints;

      const userAnswer = answers[question.id];
      if (userAnswer !== undefined && userAnswer !== null) {
        // For multiple choice, score by comparing to correctAnswer.
        // If correctAnswer is a number, treat it as the minimum acceptable option index
        // (i.e., any option at or above that index earns full credit).
        // If correctAnswer is a string, require an exact match.
        if (question.type === 'multiple-choice') {
          let isCorrect = false;
          if (typeof question.correctAnswer === 'number' && Array.isArray(question.options)) {
            // The client (job-exam.tsx) submits the selected option's 0-based
            // index as a string. Interpret it as an index; fall back to a text
            // match only if it isn't a valid index (defensive for callers that
            // submit the option text instead).
            let selectedIndex = parseInt(userAnswer, 10);
            if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= question.options.length) {
              selectedIndex = question.options.indexOf(userAnswer);
            }
            isCorrect = selectedIndex !== -1 && selectedIndex >= question.correctAnswer;
          } else {
            isCorrect = userAnswer === question.correctAnswer;
          }
          if (isCorrect) {
            earnedPoints += questionPoints;
            correctAnswers++;
          }
        }
        // For short-answer, collect for AI scoring
        else if (question.type === 'short-answer' && userAnswer.toString().trim().length > 0) {
          shortAnswerQuestions.push({ question, answer: userAnswer.toString() });
        }
      }
    }

    // AI score short-answer questions if Groq is available
    if (shortAnswerQuestions.length > 0 && jobContext) {
      await this.scoreShortAnswersWithAI(shortAnswerQuestions, jobContext, (aiScore, questionPoints) => {
        earnedPoints += aiScore * questionPoints;
        if (aiScore >= 0.6) {correctAnswers++;}
      });
    } else {
      // Fallback: give full credit for any answer
      for (const { question } of shortAnswerQuestions) {
        const questionPoints = question.points || 10;
        earnedPoints += questionPoints;
        correctAnswers++;
      }
    }

    const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    return { score, correctAnswers };
  }

  private async scoreShortAnswersWithAI(
    shortAnswerQuestions: { question: any; answer: string }[],
    jobContext: { title: string; description?: string },
    onScore: (normalizedScore: number, maxPoints: number) => void
  ): Promise<void> {
    if (!isAIAvailable()) {
      // Fallback: give full credit
      for (const { question } of shortAnswerQuestions) {
        onScore(1, question.points || 10);
      }
      return;
    }

    try {
      const prompt = `You are an expert technical interviewer. Score each candidate's answer to the following short-answer questions.

Job Context: ${jobContext.title}
${jobContext.description ? `Job Description: ${jobContext.description.slice(0, 500)}` : ''}

For each question, provide a score from 0-100 and brief reasoning.
Return JSON array with format:
[
  { "question": "question text", "answer": "candidate's answer", "score": number, "reasoning": "brief explanation" }
]

Questions:
${shortAnswerQuestions.map((q, i) => `${i + 1}. ${q.question.text || q.question.prompt}`).join('\n')}

Answers:
${shortAnswerQuestions.map((q, i) => `${i + 1}. ${q.answer}`).join('\n')}`;

      const content = await Promise.race([
        callAI(
          'You are an expert technical interviewer scoring candidate answers.',
          prompt,
          { priority: 'critical', estimatedTokens: 2500, temperature: 0.1, maxOutputTokens: 2000 }
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI scoring timeout')), 30000))
      ]);

      if (content) {
        let results: any;
        try { results = JSON.parse(content); } catch { results = null; }
        if (!results) {
          // Malformed AI response — give full credit
          for (const { question } of shortAnswerQuestions) { onScore(1, question.points || 10); }
          return;
        }
        const scores = Array.isArray(results) ? results : results.scores || [];
        
        for (let i = 0; i < shortAnswerQuestions.length; i++) {
          const scoreData = scores[i];
          if (scoreData && typeof scoreData.score === 'number') {
            const normalizedScore = Math.max(0, Math.min(1, scoreData.score / 100));
            const maxPoints = shortAnswerQuestions[i].question.points || 10;
            onScore(normalizedScore, maxPoints);
            console.log(`[ExamService] AI scored short-answer ${i + 1}: ${scoreData.score}/100`);
          } else {
            // Default to full credit if AI fails to parse
            onScore(1, shortAnswerQuestions[i].question.points || 10);
          }
        }
      }
    } catch (error) {
      console.warn('[ExamService] AI scoring failed, using fallback:', error);
      // Fallback: give full credit
      for (const { question } of shortAnswerQuestions) {
        onScore(1, question.points || 10);
      }
    }
  }
}
