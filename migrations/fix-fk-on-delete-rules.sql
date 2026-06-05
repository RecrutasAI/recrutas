-- Reconcile prod FK ON DELETE rules with shared/schema.ts.
-- Prod had 42/52 FKs as NO ACTION though the schema declares ON DELETE CASCADE
-- (or SET NULL for 3). This blocked deleting any user/job/application in prod.
-- Generated from live FK metadata. Each FK is dropped and recreated with its declared rule.
-- agent_tasks.* is NOT in schema.ts; included as CASCADE because it references core tables
-- (job/application/candidate) and would otherwise block their deletion.

-- activity_logs.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "activity_logs" DROP CONSTRAINT "activity_logs_user_id_users_id_fk";
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- agent_tasks.application_id -> job_applications(id): NO ACTION => CASCADE
ALTER TABLE "agent_tasks" DROP CONSTRAINT "agent_tasks_application_id_job_applications_id_fk";
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE;

-- agent_tasks.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "agent_tasks" DROP CONSTRAINT "agent_tasks_candidate_id_users_id_fk";
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- agent_tasks.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "agent_tasks" DROP CONSTRAINT "agent_tasks_job_id_job_postings_id_fk";
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- application_events.application_id -> job_applications(id): NO ACTION => CASCADE
ALTER TABLE "application_events" DROP CONSTRAINT "application_events_application_id_job_applications_id_fk";
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE;

-- application_insights.application_id -> job_applications(id): NO ACTION => CASCADE
ALTER TABLE "application_insights" DROP CONSTRAINT "application_insights_application_id_job_applications_id_fk";
ALTER TABLE "application_insights" ADD CONSTRAINT "application_insights_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE;

-- application_insights.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "application_insights" DROP CONSTRAINT "application_insights_candidate_id_users_id_fk";
ALTER TABLE "application_insights" ADD CONSTRAINT "application_insights_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- application_updates.application_id -> job_applications(id): NO ACTION => CASCADE
ALTER TABLE "application_updates" DROP CONSTRAINT "application_updates_application_id_job_applications_id_fk";
ALTER TABLE "application_updates" ADD CONSTRAINT "application_updates_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE;

-- candidate_users.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "candidate_users" DROP CONSTRAINT "candidate_users_user_id_users_id_fk";
ALTER TABLE "candidate_users" ADD CONSTRAINT "candidate_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- chat_messages.chat_room_id -> chat_rooms(id): NO ACTION => CASCADE
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_chat_room_id_chat_rooms_id_fk";
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_room_id_chat_rooms_id_fk" FOREIGN KEY ("chat_room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE;

-- chat_messages.sender_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_sender_id_users_id_fk";
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- chat_rooms.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_candidate_id_users_id_fk";
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- chat_rooms.exam_attempt_id -> exam_attempts(id): NO ACTION => CASCADE
ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_exam_attempt_id_exam_attempts_id_fk";
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_exam_attempt_id_exam_attempts_id_fk" FOREIGN KEY ("exam_attempt_id") REFERENCES "exam_attempts"("id") ON DELETE CASCADE;

-- chat_rooms.hiring_manager_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_hiring_manager_id_users_id_fk";
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_hiring_manager_id_users_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- chat_rooms.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_job_id_job_postings_id_fk";
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- connection_status.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "connection_status" DROP CONSTRAINT "connection_status_user_id_users_id_fk";
ALTER TABLE "connection_status" ADD CONSTRAINT "connection_status_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- exam_attempts.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "exam_attempts" DROP CONSTRAINT "exam_attempts_candidate_id_users_id_fk";
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- exam_attempts.exam_id -> job_exams(id): NO ACTION => CASCADE
ALTER TABLE "exam_attempts" DROP CONSTRAINT "exam_attempts_exam_id_job_exams_id_fk";
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_exam_id_job_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "job_exams"("id") ON DELETE CASCADE;

-- exam_attempts.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "exam_attempts" DROP CONSTRAINT "exam_attempts_job_id_job_postings_id_fk";
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- interviews.application_id -> job_applications(id): NO ACTION => CASCADE
ALTER TABLE "interviews" DROP CONSTRAINT "interviews_application_id_job_applications_id_fk";
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE;

-- interviews.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "interviews" DROP CONSTRAINT "interviews_candidate_id_users_id_fk";
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- interviews.interviewer_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "interviews" DROP CONSTRAINT "interviews_interviewer_id_users_id_fk";
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- interviews.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "interviews" DROP CONSTRAINT "interviews_job_id_job_postings_id_fk";
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- job_applications.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "job_applications" DROP CONSTRAINT "job_applications_candidate_id_users_id_fk";
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- job_applications.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "job_applications" DROP CONSTRAINT "job_applications_job_id_job_postings_id_fk";
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- job_applications.match_id -> job_matches(id): NO ACTION => SET NULL
ALTER TABLE "job_applications" DROP CONSTRAINT "job_applications_match_id_job_matches_id_fk";
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_match_id_job_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "job_matches"("id") ON DELETE SET NULL;

-- job_exams.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "job_exams" DROP CONSTRAINT "job_exams_job_id_job_postings_id_fk";
ALTER TABLE "job_exams" ADD CONSTRAINT "job_exams_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- job_matches.candidate_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "job_matches" DROP CONSTRAINT "job_matches_candidate_id_users_id_fk";
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- job_matches.job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "job_matches" DROP CONSTRAINT "job_matches_job_id_job_postings_id_fk";
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- job_postings.hiring_manager_id -> users(id): NO ACTION => SET NULL
ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_hiring_manager_id_users_id_fk";
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_hiring_manager_id_users_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- job_postings.talent_owner_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "job_postings" DROP CONSTRAINT "job_postings_talent_owner_id_users_id_fk";
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_talent_owner_id_users_id_fk" FOREIGN KEY ("talent_owner_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- match_feedback.match_id -> job_matches(id): NO ACTION => CASCADE
ALTER TABLE "match_feedback" DROP CONSTRAINT "match_feedback_match_id_job_matches_id_fk";
ALTER TABLE "match_feedback" ADD CONSTRAINT "match_feedback_match_id_job_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "job_matches"("id") ON DELETE CASCADE;

-- match_feedback.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "match_feedback" DROP CONSTRAINT "match_feedback_user_id_users_id_fk";
ALTER TABLE "match_feedback" ADD CONSTRAINT "match_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- notification_preferences.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_user_id_users_id_fk";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- notifications.related_application_id -> job_applications(id): NO ACTION => CASCADE
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_related_application_id_job_applications_id_fk";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_application_id_job_applications_id_fk" FOREIGN KEY ("related_application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE;

-- notifications.related_job_id -> job_postings(id): NO ACTION => CASCADE
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_related_job_id_job_postings_id_fk";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_job_id_job_postings_id_fk" FOREIGN KEY ("related_job_id") REFERENCES "job_postings"("id") ON DELETE CASCADE;

-- notifications.related_match_id -> job_matches(id): NO ACTION => CASCADE
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_related_match_id_job_matches_id_fk";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_match_id_job_matches_id_fk" FOREIGN KEY ("related_match_id") REFERENCES "job_matches"("id") ON DELETE CASCADE;

-- notifications.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_users_id_fk";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- talent_owner_profiles.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "talent_owner_profiles" DROP CONSTRAINT "talent_owner_profiles_user_id_users_id_fk";
ALTER TABLE "talent_owner_profiles" ADD CONSTRAINT "talent_owner_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- usage_tracking.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "usage_tracking" DROP CONSTRAINT "usage_tracking_user_id_users_id_fk";
ALTER TABLE "usage_tracking" ADD CONSTRAINT "usage_tracking_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- user_subscriptions.tier_id -> subscription_tiers(id): NO ACTION => SET NULL
ALTER TABLE "user_subscriptions" DROP CONSTRAINT "user_subscriptions_tier_id_subscription_tiers_id_fk";
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_tier_id_subscription_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "subscription_tiers"("id") ON DELETE SET NULL;

-- user_subscriptions.user_id -> users(id): NO ACTION => CASCADE
ALTER TABLE "user_subscriptions" DROP CONSTRAINT "user_subscriptions_user_id_users_id_fk";
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
