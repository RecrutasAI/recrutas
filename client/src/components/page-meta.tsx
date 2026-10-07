/**
 * PageMeta — updates document.title and meta[description] on every route change.
 *
 * Renders nothing. Mount once inside <Switch> in App.tsx.
 * Googlebot runs JS so it will see these per-route values.
 * OG/Twitter tags remain the static homepage values in index.html
 * (social scrapers don't run JS).
 */
import { useEffect } from 'react';
import { useLocation } from 'wouter';

interface RouteMeta {
  title: string;
  description: string;
  noindex?: boolean;
}

const SITE = 'Recrutas';

const ROUTES: Record<string, RouteMeta> = {
  '/': {
    title: `${SITE} | Real jobs. Made to fit you.`,
    description:
      'Upload your resume once. Get live US roles from company career pages, ranked by fit with an honest verdict on each, then hear what happened after you apply. Free for candidates.',
  },
  '/manifesto': {
    title: `Manifesto | ${SITE}`,
    description:
      'No one should have to beg for the right to earn a living. Real jobs, pulled straight from the source, made to fit you. No ghosts. No leftovers. No silence.',
  },
  '/docs': {
    title: `Developer docs: MCP connector | ${SITE}`,
    description:
      'Connect Claude Code, Codex, Cursor or any MCP client to Recrutas: your job matches with honest verdicts, job requirements, and what happened to your applications.',
  },
  '/pricing': {
    title: `Pricing | ${SITE}`,
    description:
      'Simple, transparent pricing for candidates and recruiters. Start free. No credit card required.',
  },
  '/signup/candidate': {
    title: `Join as a Candidate | ${SITE}`,
    description:
      'Create your profile and get AI-matched to top full-time roles instantly. No more endless applications.',
  },
  '/signup/talent-owner': {
    title: `Post Jobs & Hire | ${SITE}`,
    description:
      'Find pre-screened, AI-matched candidates for your open roles. Post a job and start interviewing today.',
  },
  '/auth': {
    title: `Sign In | ${SITE}`,
    description: 'Sign in to your Recrutas account to continue your job search or manage your hiring pipeline.',
    noindex: true,
  },
  '/forgot-password': {
    title: `Reset Password | ${SITE}`,
    description: 'Reset your Recrutas account password.',
    noindex: true,
  },
  '/reset-password': {
    title: `Set New Password | ${SITE}`,
    description: 'Choose a new password for your Recrutas account.',
    noindex: true,
  },
  '/privacy': {
    title: `Privacy Policy | ${SITE}`,
    description: 'What Recrutas collects, how it is used (including the browser extension, AI processing and the MCP connector), who processes it, and your choices.',
  },
  '/terms': {
    title: `Terms of Service | ${SITE}`,
    description: 'Read the terms governing your use of the Recrutas AI hiring platform.',
  },
  '/candidate-dashboard': {
    title: `Candidate Dashboard | ${SITE}`,
    description: 'Your AI-matched jobs, applications, and chats, all in one place.',
    noindex: true,
  },
  '/talent-dashboard': {
    title: `Recruiter Dashboard | ${SITE}`,
    description: 'Manage job postings, review candidates, and track your hiring pipeline.',
    noindex: true,
  },
};

const DEFAULT: RouteMeta = {
  title: `${SITE} | AI-Driven Hiring Platform`,
  description:
    'AI-powered instant job matching that connects qualified candidates with full-time roles in real-time.',
};

function setMeta(meta: RouteMeta) {
  document.title = meta.title;

  // Description
  const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (desc) desc.content = meta.description;

  // Robots
  let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (meta.noindex) {
    if (!robots) {
      robots = document.createElement('meta');
      robots.name = 'robots';
      document.head.appendChild(robots);
    }
    robots.content = 'noindex, follow';
  } else if (robots) {
    robots.content = 'index, follow';
  }

  // Canonical — keep it pointing to current path to avoid duplicate content
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = `${window.location.origin}${location.pathname}`;
}

export default function PageMeta() {
  const [loc] = useLocation();

  useEffect(() => {
    // Prefix-match for dynamic routes like /exam/:id and /chat/:id
    const meta =
      ROUTES[loc] ??
      Object.entries(ROUTES).find(([k]) => loc.startsWith(k + '/') && k !== '/')?.[1] ??
      DEFAULT;

    setMeta(meta);
  }, [loc]);

  return null;
}
