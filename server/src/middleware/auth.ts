import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export function signToken(userId: string, email: string, extra: Record<string, unknown> = {}): string {
  return jwt.sign({ sub: userId, email, ...extra }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

export interface TokenPayload {
  sub: string;
  email: string;
  /** set when the operator started the Instagram OAuth flow for a specific @username */
  igUsername?: string;
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email || ''),
      ...(typeof payload.igUsername === 'string' && payload.igUsername ? { igUsername: payload.igUsername } : {}),
    };
  } catch {
    return null;
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  // WebSocket upgrades authenticate via query param
  const q = req.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/** Requires a valid JWT on every /api route except the first-run setup endpoints. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired session' });
  req.userId = payload.sub;
  req.userEmail = payload.email;
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense: state-changing requests must be same-origin.
 * The SPA sends Authorization headers (not cookies), which already blocks
 * classic cross-site form CSRF; this is defense-in-depth per spec §7.
 *
 * Host is compared unmodified (dev proxy must not rewrite it — see vite.config),
 * plus WEB_ORIGIN / PUBLIC_URL / TRUSTED_ORIGINS for reverse-proxy deployments.
 */
export function originGuard(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // curl / server-to-server (webhooks are signature-verified)
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'Invalid origin' });
  }
  const allowed = new Set<string>([
    String(req.headers.host || ''),
    new URL(config.webOrigin).host,
    new URL(config.publicUrl).host,
    ...config.trustedOrigins.map((o) => {
      try {
        return new URL(o).host;
      } catch {
        return '';
      }
    }),
  ]);
  if (!allowed.has(originHost)) return res.status(403).json({ error: 'Cross-origin request blocked' });
  next();
}

/** Minimal in-memory sliding-window rate limiter for auth + expensive endpoints. */
const buckets = new Map<string, number[]>();

export function rateLimit(windowMs: number, max: number, keyPrefix: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${keyPrefix}:${req.ip || 'unknown'}`;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  // eslint-disable-next-line no-console
  console.error('[api:error]', message);
  if (res.headersSent) return;
  res.status(500).json({ error: message });
}
