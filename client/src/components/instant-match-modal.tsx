import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Brain, Briefcase, MapPin, ArrowRight, Sparkles,
  MessageCircle, Heart, Zap, TrendingUp, Users, Star,
  Building,
  Rocket, Award, ChevronRight, ArrowLeft
} from "lucide-react";
import SmartLogo from '@/components/smart-logo';
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@/components/theme-provider";

const JobCard = ({ job, index, onApply, onLike, onChat, isLiked, theme }: { job: any; index: number; onApply: (id: number) => void; onLike: (id: number) => void; onChat: (id: number) => void; isLiked: boolean; theme: string }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: index * 0.1 + 0.3 }}
    className={`border rounded-xl p-4 sm:p-5 transition-all duration-300 cursor-pointer backdrop-blur-sm shadow-lg hover:shadow-xl ${
      theme === 'dark'
        ? 'bg-slate-800/80 border-slate-700/50 hover:border-blue-500/50'
        : 'bg-white border-gray-200 hover:border-blue-400'
    }`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center shrink-0 ${
          theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-100'
        }`}>
          <Building className={`w-5 h-5 sm:w-6 sm:h-6 ${theme === 'dark' ? 'text-slate-400' : 'text-gray-500'}`} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className={`font-bold text-base sm:text-lg truncate ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
            {job.job?.title || job.title}
          </h4>
          <p className={`text-sm truncate ${theme === 'dark' ? 'text-slate-300' : 'text-gray-600'}`}>
            {job.job?.company || job.company}
          </p>
          <p className={`text-xs mt-0.5 ${theme === 'dark' ? 'text-slate-400' : 'text-gray-500'}`}>
            {job.job?.location || job.location || 'Remote'}
          </p>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="flex items-center gap-1 sm:gap-2">
          <Badge className={`text-xs ${
            theme === 'dark'
              ? 'bg-blue-500/20 text-blue-300 border-blue-400/30'
              : 'bg-green-100 text-green-700 border-green-200'
          }`}>
            <Star className="w-3 h-3 mr-1" />
            {job.matchScore || job.match || '90%'}
          </Badge>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onLike(job.id)}
            className="h-8 w-8"
          >
            <Heart className={`w-4 h-4 sm:w-5 sm:h-5 ${
              isLiked
                ? 'text-red-500 fill-current'
                : theme === 'dark'
                  ? 'text-slate-400'
                  : 'text-gray-400'
            }`} />
          </Button>
        </div>
        {(job.job?.salaryMin && job.job?.salaryMax) || job.salary ? (
          <p className={`text-sm font-semibold mt-1 sm:mt-2 ${theme === 'dark' ? 'text-slate-200' : 'text-gray-800'}`}>
            {job.job?.salaryMin && job.job?.salaryMax
              ? `$${(job.job.salaryMin / 1000).toFixed(0)}k to ${(job.job.salaryMax / 1000).toFixed(0)}k`
              : job.salary}
          </p>
        ) : null}
      </div>
    </div>
    <div className="mt-3 sm:mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex flex-wrap gap-1">
        {(job.job?.skills || job.skills || []).slice(0, 3).map((skill: string) => (
          <Badge key={skill} variant="secondary" className="text-xs">
            {skill}
          </Badge>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChat(job.id)}
          className="flex-1 sm:flex-none"
        >
          <MessageCircle className="w-4 h-4 mr-1" />
          <span className="hidden sm:inline">Chat</span>
        </Button>
        <Button
          size="sm"
          onClick={() => onApply(job.id)}
          className="flex-1 sm:flex-none bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
        >
          <Zap className="w-4 h-4 mr-1" />
          Apply
        </Button>
      </div>
    </div>
  </motion.div>
);

const JobCardSkeleton = ({ theme }: { theme: string }) => (
  <div className={`border rounded-xl p-4 sm:p-5 shadow-lg ${
    theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50' : 'bg-white border-gray-200'
  }`}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg animate-pulse ${
          theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
        }`} />
        <div className="space-y-2">
          <div className={`w-32 sm:w-48 h-4 rounded animate-pulse ${
            theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
          }`} />
          <div className={`w-20 sm:w-32 h-3 rounded animate-pulse ${
            theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
          }`} />
        </div>
      </div>
      <div className="text-right space-y-2">
        <div className={`w-16 sm:w-20 h-6 rounded-full animate-pulse ${
          theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
        }`} />
        <div className={`w-16 sm:w-20 h-4 rounded animate-pulse ${
          theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
        }`} />
      </div>
    </div>
    <div className="mt-4 flex items-center justify-between">
      <div className="flex gap-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`w-12 sm:w-16 h-6 rounded-full animate-pulse ${
            theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
          }`} />
        ))}
      </div>
      <div className="flex gap-2">
        <div className={`w-16 sm:w-20 h-8 rounded-lg animate-pulse ${
          theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
        }`} />
        <div className={`w-16 sm:w-20 h-8 rounded-lg animate-pulse ${
          theme === 'dark' ? 'bg-slate-700/50' : 'bg-gray-200'
        }`} />
      </div>
    </div>
  </div>
);

interface InstantMatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartMatching: () => void;
  initialSkills?: string;
}

export default function InstantMatchModal({ isOpen, onClose, onStartMatching, initialSkills = "" }: InstantMatchModalProps) {
  const { theme } = useTheme();
  const [step, setStep] = useState<'intro' | 'skills' | 'results' | 'features'>('intro');
  const [skills, setSkills] = useState(initialSkills);
  const [jobTitle, setJobTitle] = useState("");
  const [location, setLocation] = useState("");
  const [workType, setWorkType] = useState<'remote' | 'hybrid' | 'onsite' | 'any'>('any');
  const [likedJobs, setLikedJobs] = useState<number[]>([]);

  // Debounced values — only update after 400 ms of no typing.
  // This prevents firing a DB query on every keystroke.
  const [debouncedTitle, setDebouncedTitle]    = useState(jobTitle);
  const [debouncedSkills, setDebouncedSkills]  = useState(skills);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedTitle(jobTitle);
      setDebouncedSkills(skills);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [jobTitle, skills]);

  // Reset to intro every time the modal opens so returning visitors don't land
  // on a stale results screen.
  useEffect(() => {
    if (isOpen) {
      setStep('intro');
      setSkills(initialSkills);
      setJobTitle("");
      setLocation("");
      setWorkType('any');
      setLikedJobs([]);
    }
  }, [isOpen, initialSkills]);

  // Fetch external jobs based on skills and filters.
  // enabled as soon as the debounced jobTitle/skills has a value — even while
  // the user is still on the 'skills' step — so data is ready (or in-flight)
  // the moment they hit "Find My Matches" and the results step appears.
  const { data: externalJobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['/api/external-jobs', debouncedSkills, debouncedTitle, location, workType],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '8' });
      if (debouncedSkills.trim()) {params.append('skills', debouncedSkills.trim());}
      if (debouncedTitle.trim()) {params.append('jobTitle', debouncedTitle.trim());}
      if (location.trim()) {params.append('location', location.trim());}
      if (workType !== 'any') {params.append('workType', workType);}

      const response = await fetch(`/api/external-jobs?${params}`);
      if (!response.ok) {throw new Error('Failed to fetch jobs');}
      return response.json();
    },
    enabled: !!debouncedTitle.trim() || !!debouncedSkills.trim(),
    staleTime: 5 * 60 * 1000, // 5 min — DB results don't change second-to-second
    retry: 2,
  });

  const jobsToShow: any[] = (externalJobsData?.jobs ?? []).slice(0, 8);

  const handleSkillsSubmit = () => {
    if (jobTitle.trim() || skills.trim()) {
      setStep('results');
    }
  };

  const handleQuickApply = (jobId: number) => {
    const job = jobsToShow.find((j: any) => j.id === jobId);
    if (job) {
      localStorage.setItem('continuationJob', JSON.stringify({
        id: job.id,
        jobData: job.job ?? job,
        source: job.source,
        externalUrl: job.externalUrl,
        matchScore: job.matchScore,
        timestamp: Date.now(),
        action: 'apply'
      }));

      sessionStorage.setItem('pendingJobApplication', JSON.stringify({
        jobId: job.id,
        title: job.job?.title ?? job.title,
        company: job.job?.company ?? job.company,
        action: 'apply'
      }));
    }

    onStartMatching();
    onClose();
  };

  const handleLikeJob = (jobId: number) => {
    setLikedJobs(prev =>
      prev.includes(jobId)
        ? prev.filter(id => id !== jobId)
        : [...prev, jobId]
    );
  };

  const handleStartChat = (_jobId: number) => {
    onStartMatching();
    onClose();
  };

  const handleGetStarted = () => {
    onStartMatching();
    onClose();
  };

  const handleBack = () => {
    if (step === 'skills') {setStep('intro');}
    else if (step === 'results') {setStep('skills');}
    else if (step === 'features') {setStep('results');}
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={`p-0 border-0 flex flex-col ${
        theme === 'dark' ? 'bg-slate-900' : 'bg-white'
      } backdrop-blur-2xl shadow-2xl max-w-4xl w-[95vw] max-h-[90vh] overflow-hidden`}>
        <DialogTitle className="sr-only">Instant Job Matching</DialogTitle>
        <DialogDescription className="sr-only">
          Find your perfect job match in 30 seconds with AI-powered recommendations
        </DialogDescription>

        {/* Animated background */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-gradient-to-br from-blue-400/20 to-purple-600/20 rounded-full blur-3xl animate-pulse" />
          <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-gradient-to-tr from-indigo-400/20 to-cyan-600/20 rounded-full blur-3xl animate-pulse delay-1000" />
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-gradient-to-r from-purple-400/10 to-pink-600/10 rounded-full blur-3xl animate-pulse delay-500" />
        </div>

        {/* Header with back button and logo */}
        <div className="relative z-10 flex items-center justify-between p-4 sm:p-6 border-b border-slate-200/20 dark:border-slate-700/30">
          <div className="flex items-center gap-3">
            {step !== 'intro' && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleBack}
                className="h-8 w-8"
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
            )}
            <SmartLogo size={28} showText={true} />
          </div>
        </div>

        {/* Progress indicator */}
        {step !== 'intro' && (
          <div className="relative z-10 px-4 sm:px-6 pt-4">
            <div className="flex items-center gap-2">
              {['skills', 'results', 'features'].map((s, i) => (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div className={`h-2 rounded-full flex-1 transition-all duration-500 ${
                    ['intro', 'skills', 'results', 'features'].indexOf(step) > i
                      ? 'bg-gradient-to-r from-blue-500 to-purple-500'
                      : ['intro', 'skills', 'results', 'features'].indexOf(step) === i
                        ? 'bg-blue-500'
                        : theme === 'dark' ? 'bg-slate-700' : 'bg-gray-200'
                  }`} />
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-1 text-xs text-slate-500">
              <span>Preferences</span>
              <span>Matches</span>
              <span>Features</span>
            </div>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto relative z-10 p-4 sm:p-6">
          <AnimatePresence mode="wait">
            {step === 'intro' && (
              <motion.div
                key="intro"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-center max-w-2xl mx-auto"
              >
                {/* Hero Badge */}
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.1 }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 mb-6"
                >
                  <Sparkles className="w-4 h-4 text-blue-500" />
                  <span className={`text-sm font-medium ${theme === 'dark' ? 'text-blue-300' : 'text-blue-700'}`}>
                    AI-Powered Job Matching
                  </span>
                </motion.div>

                {/* Main Headline */}
                <motion.h1
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className={`text-3xl sm:text-4xl lg:text-5xl font-bold mb-4 leading-tight ${
                    theme === 'dark' ? 'text-white' : 'text-gray-900'
                  }`}
                >
                  Careers,{' '}
                  <span className="bg-gradient-to-r from-blue-500 to-purple-600 bg-clip-text text-transparent">
                    Humanized.
                  </span>
                  <br />
                  <span className="bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent">
                    Directly.
                  </span>
                </motion.h1>

                {/* Subheadline */}
                <motion.p
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className={`text-base sm:text-lg mb-8 ${theme === 'dark' ? 'text-slate-300' : 'text-gray-600'}`}
                >
                  Apply to jobs and hear back the same day. No ghosting, no guessing.
                </motion.p>

                {/* Benefits Grid */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8"
                >
                  {[
                    { icon: Brain, title: 'AI Matching', desc: 'Smart recommendations based on your skills' },
                    { icon: MessageCircle, title: 'Direct Chat', desc: 'Talk to recruiters instantly' },
                    { icon: TrendingUp, title: 'Track Progress', desc: 'Monitor all your applications' },
                  ].map((benefit, i) => (
                    <div key={i} className={`p-4 rounded-xl border ${
                      theme === 'dark'
                        ? 'bg-slate-800/50 border-slate-700/50'
                        : 'bg-gray-50 border-gray-200'
                    }`}>
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mx-auto mb-3 ${
                        theme === 'dark' ? 'bg-blue-500/20' : 'bg-blue-100'
                      }`}>
                        <benefit.icon className={`w-5 h-5 ${
                          theme === 'dark' ? 'text-blue-400' : 'text-blue-600'
                        }`} />
                      </div>
                      <h3 className={`font-semibold text-sm mb-1 ${
                        theme === 'dark' ? 'text-white' : 'text-gray-900'
                      }`}>
                        {benefit.title}
                      </h3>
                      <p className={`text-xs ${theme === 'dark' ? 'text-slate-400' : 'text-gray-500'}`}>
                        {benefit.desc}
                      </p>
                    </div>
                  ))}
                </motion.div>

                {/* CTA Button */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6 }}
                >
                  <Button
                    size="lg"
                    className="w-full sm:w-auto px-8 py-6 text-lg font-semibold text-white rounded-xl shadow-lg bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all duration-300 hover:shadow-xl hover:scale-105"
                    onClick={() => setStep('skills')}
                  >
                    <Rocket className="w-5 h-5 mr-2" />
                    Start Matching Now
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </motion.div>

              </motion.div>
            )}

            {step === 'skills' && (
              <motion.div
                key="skills"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-2xl mx-auto"
              >
                <div className="text-center mb-6">
                  <h2 className={`text-2xl sm:text-3xl font-bold mb-2 ${
                    theme === 'dark' ? 'text-white' : 'text-gray-900'
                  }`}>
                    What role are you looking for?
                  </h2>
                  <p className={`${theme === 'dark' ? 'text-slate-300' : 'text-gray-600'}`}>
                    We'll find the best matches for you
                  </p>
                </div>

                <div className="space-y-6">
                  {/* Job Title */}
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${
                      theme === 'dark' ? 'text-slate-300' : 'text-gray-700'
                    }`}>
                      Job Title
                    </label>
                    <Input
                      placeholder="e.g. Software Engineer, Product Manager..."
                      value={jobTitle}
                      onChange={(e) => setJobTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSkillsSubmit()}
                      className={`text-base sm:text-lg p-4 rounded-xl border-2 ${
                        theme === 'dark'
                          ? 'bg-slate-800/50 border-slate-700/50 text-white placeholder:text-slate-500'
                          : 'bg-white border-gray-300 text-gray-900'
                      }`}
                      autoFocus
                    />
                    <div className="flex flex-wrap gap-2 mt-3">
                      {['Software Engineer', 'Product Manager', 'Data Scientist', 'Designer', 'Marketing'].map((role) => (
                        <Badge
                          key={role}
                          variant="secondary"
                          className={`cursor-pointer text-xs ${
                            theme === 'dark'
                              ? 'bg-slate-800/50 border-slate-700/50 text-slate-300 hover:bg-slate-700/50'
                              : 'bg-gray-100 border-gray-200 text-gray-700 hover:bg-gray-200'
                          }`}
                          onClick={() => setJobTitle(role)}
                        >
                          {role}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Location */}
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${
                      theme === 'dark' ? 'text-slate-300' : 'text-gray-700'
                    }`}>
                      <MapPin className="w-4 h-4 inline mr-1" />
                      Preferred Location
                    </label>
                    <Input
                      placeholder="City, Country, or Remote"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSkillsSubmit()}
                      className={`p-3 rounded-xl border-2 ${
                        theme === 'dark'
                          ? 'bg-slate-800/50 border-slate-700/50 text-white'
                          : 'bg-white border-gray-300 text-gray-900'
                      }`}
                    />
                  </div>

                  {/* Work Type */}
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${
                      theme === 'dark' ? 'text-slate-300' : 'text-gray-700'
                    }`}>
                      Work Type
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { value: 'any', label: 'Any' },
                        { value: 'remote', label: 'Remote' },
                        { value: 'hybrid', label: 'Hybrid' },
                        { value: 'onsite', label: 'On-site' },
                      ].map((option) => (
                        <button
                          key={option.value}
                          onClick={() => setWorkType(option.value as typeof workType)}
                          className={`p-3 rounded-lg border text-sm font-medium transition-all ${
                            workType === option.value
                              ? 'border-blue-500 bg-blue-500/10 text-blue-600'
                              : theme === 'dark'
                                ? 'border-slate-700/50 bg-slate-800/50 text-slate-300 hover:border-slate-600'
                                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Submit Button */}
                  <Button
                    size="lg"
                    className="w-full py-4 text-lg font-semibold text-white rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleSkillsSubmit}
                    disabled={!jobTitle.trim()}
                  >
                    Find My Matches
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </Button>

                  {!jobTitle.trim() && (
                    <p className="text-center text-xs text-slate-500">
                      Enter a job title to continue
                    </p>
                  )}
                </div>
              </motion.div>
            )}

            {step === 'results' && (
              <motion.div
                key="results"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <div className="text-center mb-6">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.2, duration: 0.4 }}
                    className="w-16 h-16 mx-auto bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center shadow-xl mb-4"
                  >
                    <Sparkles className="w-8 h-8 text-white" />
                  </motion.div>
                  <h3 className={`text-2xl font-bold mb-2 ${
                    theme === 'dark' ? 'text-white' : 'text-gray-900'
                  }`}>
                    {jobsLoading ? 'Finding Matches...' : `${jobsToShow.length} Jobs Found`}
                  </h3>
                  <p className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-gray-600'}`}>
                    Based on: {jobTitle}
                    {location && ` • ${location}`}
                    {workType !== 'any' && ` • ${workType}`}
                  </p>
                </div>

                <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
                  {jobsLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <JobCardSkeleton key={i} theme={theme} />
                    ))
                  ) : jobsToShow.length === 0 ? (
                    <div className="text-center py-12">
                      <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4 ${
                        theme === 'dark' ? 'bg-slate-800' : 'bg-gray-100'
                      }`}>
                        <Briefcase className={`w-8 h-8 ${
                          theme === 'dark' ? 'text-slate-600' : 'text-gray-400'
                        }`} />
                      </div>
                      <p className={`${theme === 'dark' ? 'text-slate-300' : 'text-gray-600'} mb-2`}>
                        No jobs found for "{jobTitle}"
                      </p>
                      <p className={`text-sm ${theme === 'dark' ? 'text-slate-500' : 'text-gray-500'}`}>
                        Try adjusting your search or location
                      </p>
                      <Button
                        variant="outline"
                        className="mt-4"
                        onClick={() => setStep('skills')}
                      >
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Modify Search
                      </Button>
                    </div>
                  ) : (
                    jobsToShow.map((job: any, index: number) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        index={index}
                        onApply={handleQuickApply}
                        onLike={handleLikeJob}
                        onChat={handleStartChat}
                        isLiked={likedJobs.includes(job.id)}
                        theme={theme}
                      />
                    ))
                  )}
                </div>

                {!jobsLoading && jobsToShow.length > 0 && (
                  <div className="mt-6 space-y-3">
                    <Button
                      size="lg"
                      className="w-full py-4 text-lg font-semibold text-white rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-lg"
                      onClick={handleGetStarted}
                    >
                      Create Free Account
                      <ArrowRight className="w-5 h-5 ml-2" />
                    </Button>
                    <div className="flex gap-3">
                      <Button
                        onClick={() => setStep('features')}
                        variant="outline"
                        className="flex-1"
                      >
                        <TrendingUp className="w-4 h-4 mr-2" />
                        See Features
                      </Button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {step === 'features' && (
              <motion.div
                key="features"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <div className="text-center mb-6">
                  <h3 className={`text-2xl sm:text-3xl font-bold mb-2 ${
                    theme === 'dark' ? 'text-white' : 'text-gray-900'
                  }`}>
                    Everything You Need
                  </h3>
                  <p className={`${theme === 'dark' ? 'text-slate-400' : 'text-gray-600'}`}>
                    Powerful tools to accelerate your job search
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                  {[
                    {
                      icon: Brain,
                      title: 'AI-Powered Matching',
                      desc: 'Get personalized job recommendations based on your skills and experience',
                      color: 'blue'
                    },
                    {
                      icon: MessageCircle,
                      title: 'Direct Recruiter Chat',
                      desc: 'Message hiring managers directly and get faster responses',
                      color: 'green'
                    },
                    {
                      icon: TrendingUp,
                      title: 'Application Tracking',
                      desc: 'Track all your applications in one place with real-time updates',
                      color: 'purple'
                    },
                    {
                      icon: Zap,
                      title: 'One-Click Apply',
                      desc: 'Apply to jobs instantly with your pre-filled profile',
                      color: 'orange'
                    },
                    {
                      icon: Users,
                      title: 'Profile Analytics',
                      desc: 'See who viewed your profile and track your job search success',
                      color: 'teal'
                    },
                    {
                      icon: Award,
                      title: 'Verified Employers',
                      desc: 'All jobs are verified to ensure legitimacy and quality',
                      color: 'yellow'
                    },
                  ].map((feature, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.1 }}
                      className={`p-4 rounded-xl border ${
                        theme === 'dark'
                          ? 'bg-slate-800/50 border-slate-700/50'
                          : 'bg-white border-gray-200'
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${
                        feature.color === 'blue' ? 'bg-blue-500/20' :
                        feature.color === 'green' ? 'bg-green-500/20' :
                        feature.color === 'purple' ? 'bg-purple-500/20' :
                        feature.color === 'orange' ? 'bg-orange-500/20' :
                        feature.color === 'teal' ? 'bg-teal-500/20' :
                        'bg-yellow-500/20'
                      }`}>
                        <feature.icon className={`w-5 h-5 ${
                          feature.color === 'blue' ? 'text-blue-500' :
                          feature.color === 'green' ? 'text-green-500' :
                          feature.color === 'purple' ? 'text-purple-500' :
                          feature.color === 'orange' ? 'text-orange-500' :
                          feature.color === 'teal' ? 'text-teal-500' :
                          'text-yellow-500'
                        }`} />
                      </div>
                      <h4 className={`font-semibold mb-1 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                        {feature.title}
                      </h4>
                      <p className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-gray-600'}`}>
                        {feature.desc}
                      </p>
                    </motion.div>
                  ))}
                </div>

                <div className="text-center">
                  <Button
                    size="lg"
                    className="w-full sm:w-auto px-8 py-4 text-lg font-semibold text-white rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-lg"
                    onClick={handleGetStarted}
                  >
                    Create Free Account
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer with sign in link */}
        <div className={`relative z-10 p-4 border-t text-center ${
          theme === 'dark'
            ? 'border-slate-700/30 text-slate-500'
            : 'border-gray-200 text-gray-500'
        }`}>
          <p className="text-sm">
            Already have an account?{' '}
            <button
              onClick={handleGetStarted}
              className="font-semibold text-blue-500 hover:text-blue-600"
            >
              Sign in
            </button>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
