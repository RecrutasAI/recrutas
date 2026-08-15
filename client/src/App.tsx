import React from "react";
import { Switch, Route, Redirect } from "wouter";
import { SessionContextProvider } from "@supabase/auth-helpers-react";
import { supabase } from "@/lib/supabase-client";
import AppProviders from '@/components/AppProviders';
import Landing from "@/pages/landing-responsive";
import AuthPage from "@/pages/auth-page";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import GuidedSetup from "@/pages/guided-setup";
import CandidateDashboard from "@/pages/candidate-dashboard-streamlined";
import TalentDashboard from "@/pages/talent-dashboard";
import ExamPage from "@/pages/exam-page";
import Chat from "@/pages/chat";
import NotFound from "@/pages/not-found";
import SignUpCandidatePage from "@/pages/signup-candidate";
import SignUpTalentPage from "@/pages/signup-talent";
import PricingPage from "@/pages/pricing";
import PrivacyPolicy from "@/pages/privacy";
import TermsOfService from "@/pages/terms";
import { TopRightButtons } from '@/components/TopRightButtons';
import { FeedbackButton } from '@/components/FeedbackButton';
import { RoleGuard } from '@/components/role-guard';
import { AuthGuard } from '@/components/auth-guard';
import AdminDashboard from "@/pages/admin-dashboard";
import MetricsDashboard from "@/pages/metrics-dashboard";
import PageMeta from '@/components/page-meta';
import { IdleWatcher } from '@/components/idle-watcher';


function App() {
  // ...
  return (
    <AppProviders>
      <SessionContextProvider supabaseClient={supabase}>
        <PageMeta />
        <Switch>
          <Route path="/" component={Landing} />
          <Route path="/auth" component={AuthPage} />
          <Route path="/signup/candidate" component={SignUpCandidatePage} />
          <Route path="/signup/talent-owner" component={SignUpTalentPage} />
          <Route path="/forgot-password" component={ForgotPasswordPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />
          <Route path="/role-selection">
            <AuthGuard><GuidedSetup /></AuthGuard>
          </Route>
          <Route path="/guided-setup">
            <AuthGuard><GuidedSetup /></AuthGuard>
          </Route>
          <Route path="/candidate-dashboard">
            <RoleGuard allowedRoles={['candidate']}><CandidateDashboard /></RoleGuard>
          </Route>
          <Route path="/talent-dashboard">
            <RoleGuard allowedRoles={['talent_owner', 'recruiter']}><TalentDashboard /></RoleGuard>
          </Route>
          <Route path="/exam/:jobId">
            <RoleGuard allowedRoles={['candidate', 'talent_owner', 'recruiter']}><ExamPage /></RoleGuard>
          </Route>
          <Route path="/chat/:id">
            <RoleGuard allowedRoles={['candidate', 'talent_owner', 'recruiter']}><Chat /></RoleGuard>
          </Route>
          <Route path="/chat">
            <RoleGuard allowedRoles={['candidate', 'talent_owner', 'recruiter']}><Chat /></RoleGuard>
          </Route>
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/metrics" component={MetricsDashboard} />
          {/* The waitlist is retired: signup has been open since e1b549e, and the
              page still promised an invite code that no longer exists. It captured
              zero entries in its lifetime. Production redirects at the edge
              (see vercel.json); this keeps dev and client-side nav consistent. */}
          <Route path="/early-access"><Redirect to="/auth" /></Route>
          <Route path="/pricing" component={PricingPage} />
          <Route path="/privacy" component={PrivacyPolicy} />
          <Route path="/terms" component={TermsOfService} />
          <Route component={NotFound} />
        </Switch>
        <TopRightButtons />
        <FeedbackButton />
        <IdleWatcher />
      </SessionContextProvider>
    </AppProviders>
  );
}

export default App;
