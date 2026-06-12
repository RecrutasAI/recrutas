import dotenv from 'dotenv';
dotenv.config();

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes.js";
import { registerChatRoutes } from "./chat-routes.js";

import { supabaseAdmin } from './lib/supabase-admin.js';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { errorHandlerMiddleware, requestTracingMiddleware, captureException } from './error-monitoring.js';
import { metricsMiddleware } from './middleware/metrics.js';
import { externalJobsScheduler } from './services/external-jobs-scheduler';
import { shutdown as shutdownAnalytics } from './lib/analytics';

const app = express();

// Function to initialize Supabase Storage
async function initializeSupabase() {
  try {
    const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
    if (error) {
      console.error('Error listing buckets:', error.message);
      return;
    }

    const resumeBucket = buckets.find(bucket => bucket.name === 'resumes');
    if (!resumeBucket) {
      console.log('"resumes" bucket not found. Creating it...');
      const { error: createError } = await supabaseAdmin.storage.createBucket('resumes', {
        public: true,
      });
      if (createError) {
        console.error('Error creating "resumes" bucket:', createError.message);
      } else {
        console.log('"resumes" bucket created successfully.');
      }
    } else {
      console.log('"resumes" bucket already exists.');
    }
  } catch (e) {
    console.error('Unexpected error during Supabase initialization:', (e as Error).message);
  }
}

async function initializeBackgroundServices() {
  // DISABLE background services on Vercel serverless - they exhaust the DB connection pool
  // These services need to run on a dedicated server or via cron jobs
  const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
  const enableBackgroundServices = process.env.ENABLE_BACKGROUND_SERVICES === 'true';

  if (isServerless && !enableBackgroundServices) {
    console.log('[Services] Skipping background services (serverless environment)');
    console.log('[Services] Set ENABLE_BACKGROUND_SERVICES=true to override');
    return;
  }

  console.log('[Services] Starting background services...');

  try {
    // Start company discovery pipeline
    const { companyDiscoveryPipeline } = await import('./company-discovery.js');
    companyDiscoveryPipeline.start();
    console.log('[Services] ✓ Company discovery pipeline started');

    // Start job liveness service (if exists)
    try {
      const { jobLivenessService } = await import('./job-liveness-service.js');
      jobLivenessService.start();
      console.log('[Services] ✓ Job liveness service started');
    } catch (e) {
      console.log('[Services] Job liveness service not found, skipping');
    }

    // Start job refresh service
    try {
      const { jobRefreshService } = await import('./services/job-refresh.service.js');
      jobRefreshService.start();
      console.log('[Services] ✓ Job refresh service started');
    } catch (e) {
      console.error('[Services] Job refresh service failed to start:', e);
    }

    // Start external jobs scheduler
    try {
      externalJobsScheduler.start(3600000); // Run every hour
      console.log('[Services] ✓ External jobs scheduler started');
    } catch (e) {
      console.error('[Services] External jobs scheduler failed to start:', e);
    }

  } catch (error) {
    console.error('[Services] Error starting background services:', error);
    // Don't crash the server if background services fail
  }
}

export async function configureApp() {
  // CORS: allow Vercel deployment origins, configured FRONTEND_URL, and localhost for dev
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'http://localhost:3000',
  ].filter(Boolean) as string[];

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) {return callback(null, true);}
      if (allowedOrigins.includes(origin)) {return callback(null, true);}
      // Allow browser extension origins (Chrome/Firefox autofill extension)
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
        return callback(null, true);
      }
      // Allow this project's Vercel deployments only (recrutas.vercel.app + recrutas-*-<team>.vercel.app previews),
      // not arbitrary *.vercel.app origins
      const hostname = new URL(origin).hostname;
      if (hostname === 'recrutas.vercel.app' || (hostname.startsWith('recrutas-') && hostname.endsWith('.vercel.app'))) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true
  }));

  // Trust the first proxy (Vercel/reverse proxy) so express-rate-limit reads X-Forwarded-For correctly
  app.set('trust proxy', 1);

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // CSP: allow Supabase auth/storage, inline styles (Tailwind), wss for WebSocket
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' wss: https://*.supabase.co https://*.supabase.in https:; frame-ancestors 'none'");
    }
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  const isDevOrTest = process.env.NODE_ENV !== 'production';

  // Rate limiting: 100 requests per 15 minutes per IP (disabled for localhost in dev/test)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // Health endpoint is always accessible for monitoring
      if (req.path === '/api/health') {return true;}
      // In dev/test, skip rate limiting for localhost to allow full test suites to run
      if (isDevOrTest && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) {return true;}
      return false;
    },
    handler: (req, res) => {
      res.status(429).json({ message: 'Too many requests, please try again later.' });
    }
  });
  app.use(limiter);

  // Stricter rate limiting for auth endpoints: 10 requests per 15 minutes
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 auth requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // In dev/test, skip rate limiting for localhost
      if (isDevOrTest && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) {return true;}
      return false;
    },
    handler: (req, res) => {
      res.status(429).json({ message: 'Too many authentication attempts, please try again later.' });
    }
  });
  app.use('/api/auth/', authLimiter);

  // Stripe webhook needs raw body for signature verification — must be before express.json()
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req: any, res) => {
    try {
      const { stripeService } = await import('./services/stripe.service.js');
      const sig = req.headers['stripe-signature'];

      if (!sig) {
        return res.status(400).json({ message: "Missing stripe-signature header" });
      }

      const event = stripeService.constructWebhookEvent(req.body, sig);
      await stripeService.handleWebhook(event);

      res.json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error.message);
      res.status(400).json({ message: `Webhook Error: ${error.message}` });
    }
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Request tracing middleware for performance monitoring (Sentry)
  app.use(requestTracingMiddleware());

  // Metrics sampling middleware (20% of API requests → request_metrics table)
  app.use(metricsMiddleware());

  // Middleware for logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path.startsWith("/api")) {
        console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
      }
    });
    next();
  });

  await initializeSupabase();
  await registerRoutes(app);
  registerChatRoutes(app);

  // Only start background services if not in a test environment AND not on Vercel
  // Vercel is serverless - background services must use Vercel Cron instead
  const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV !== undefined;
  if (process.env.NODE_ENV !== 'test') {
    await initializeBackgroundServices();
  }

  // Flush PostHog events on graceful shutdown
  process.on('SIGTERM', async () => {
    await shutdownAnalytics();
    process.exit(0);
  });

  app.use(errorHandlerMiddleware());

  // Fallback error handler — catches anything asyncHandler forwards that
  // Sentry didn't consume, and returns a consistent JSON response.
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (res.headersSent) return;
    console.error('[Fallback Error Handler]', err?.message || err);
    res.status(err?.statusCode || 500).json({
      error: {
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err?.message || 'Unknown error'),
        statusCode: err?.statusCode || 500,
      },
    });
  });

  return app;
}