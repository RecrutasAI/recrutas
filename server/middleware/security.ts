import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

/** Emails allowed into the admin console with their normal Recrutas sign-in (ADMIN_EMAILS, comma-separated). */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.ADMIN_EMAILS || '').replace(/\\n/g, '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

/** The signed-in admin's email, if the request carries a valid Supabase session for an ADMIN_EMAILS account. */
export function adminEmailFromSession(req: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  const jwtSecret = env.SUPABASE_JWT_SECRET;
  const header = req.headers.authorization;
  if (!jwtSecret || !header?.startsWith('Bearer ')) {return null;}
  try {
    const payload = jwt.verify(header.slice(7), jwtSecret, { algorithms: ['HS256'] }) as any;
    const email = typeof payload?.email === 'string' ? payload.email.toLowerCase() : '';
    return email && adminEmails(env).has(email) ? email : null;
  } catch {
    return null;
  }
}

function secretMatches(req: Request): boolean {
  const secret = req.headers['x-admin-secret'] as string | undefined;
  if (!process.env.ADMIN_SECRET || !secret) {return false;}
  const expected = Buffer.from(process.env.ADMIN_SECRET);
  const received = Buffer.from(secret);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Admin check for every /api/admin route. Accepts either a normal sign-in by an
 * ADMIN_EMAILS account (the admin console) or the x-admin-secret header
 * (scripts and automation). Returns false and sends 401 otherwise.
 */
export function verifyAdminSecret(req: Request, res: Response): boolean {
  if (secretMatches(req) || adminEmailFromSession(req)) {return true;}
  res.status(401).json({ message: 'Unauthorized' });
  return false;
}

/**
 * Timing-safe cron secret verification.
 * Returns 500 if CRON_SECRET is not configured, 401 if mismatch.
 */
export function verifyCronSecret(req: Request, res: Response): boolean {
  if (!process.env.CRON_SECRET) {
    res.status(500).json({ message: 'CRON_SECRET not configured' });
    return false;
  }
  const secret = req.headers['x-cron-secret'] as string | undefined;
  if (!secret) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  const expected = Buffer.from(process.env.CRON_SECRET);
  const received = Buffer.from(secret);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Stricter rate limiter for admin endpoints: 5 attempts per 15 minutes.
 */
export const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many admin requests, please try again later' },
});
