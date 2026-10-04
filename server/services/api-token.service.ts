/**
 * Personal access tokens: how a user's AI tools (Claude Code, Cursor, …) reach
 * their Recrutas data through the MCP connector.
 *
 * Tokens look like `rk_<43 base64url chars>` (256 bits). Only the SHA-256 hash
 * is stored, so a database leak doesn't expose usable tokens; the token itself
 * is shown once, at creation. Revoking is immediate.
 */
import { createHash, randomBytes } from 'crypto';
import { db } from '../db';
import { apiTokens } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { isNull } from 'drizzle-orm/sql/expressions';
import { sql } from 'drizzle-orm/sql';

const MAX_TOKENS_PER_USER = 10;
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function createApiToken(userId: string, name: string): Promise<{ id: number; token: string; prefix: string } | { error: string }> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  if (n >= MAX_TOKENS_PER_USER) {return { error: `You can have up to ${MAX_TOKENS_PER_USER} active tokens. Revoke one first.` };}
  const token = `rk_${randomBytes(32).toString('base64url')}`;
  const prefix = token.slice(0, 10);
  const [row] = await db.insert(apiTokens).values({
    userId, name: name.trim().slice(0, 80) || 'AI tool', tokenHash: hashToken(token), tokenPrefix: prefix,
  }).returning({ id: apiTokens.id });
  return { id: row.id, token, prefix };
}

export async function listApiTokens(userId: string) {
  return db.select({
    id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.tokenPrefix,
    lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt,
  }).from(apiTokens).where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
}

export async function revokeApiToken(userId: string, id: number): Promise<boolean> {
  const rows = await db.update(apiTokens).set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return rows.length > 0;
}

/** The user a token belongs to, or null if it's unknown or revoked. */
export async function userForToken(token: string): Promise<string | null> {
  if (!/^rk_[A-Za-z0-9_-]{43}$/.test(token)) {return null;}
  const [row] = await db.select({ id: apiTokens.id, userId: apiTokens.userId, lastUsedAt: apiTokens.lastUsedAt })
    .from(apiTokens).where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt))).limit(1);
  if (!row) {return null;}
  // Record use at most hourly: every MCP call would otherwise write a row.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 3600e3) {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
  }
  return row.userId;
}
