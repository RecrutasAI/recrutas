-- Add exam_feedback column to exam_attempts table.
-- AI-generated feedback shown to candidates after they submit an exam.
-- Defined in shared/schema.ts (examAttempts.examFeedback) but never shipped to prod,
-- which blocked the entire exam → rank → chat half of the core loop
-- (PostgresError 42703: column "exam_feedback" does not exist).
ALTER TABLE exam_attempts
ADD COLUMN IF NOT EXISTS exam_feedback TEXT;
