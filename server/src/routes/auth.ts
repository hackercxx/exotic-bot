import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../db';
import { signToken, requireAuth, rateLimit, type AuthedRequest } from '../middleware/auth';
import { logEvent } from '../services/events';

// Schema for login/register credentials
const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

// Schema for forgot-password request
const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// Schema for reset-password request
const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export const authRouter = Router();

/** First-run bootstrap info (public): is this a fresh install? */
authRouter.get('/bootstrap', async (_req, res) => {
  const userCount = await prisma.user.count();
  res.json({
    needsSetup: userCount === 0,
    allowRegistration: userCount === 0 || process.env.ALLOW_REGISTRATION !== 'false',
  });
});

/** Create an account. */
authRouter.post('/register', rateLimit(60_000, 5, 'register'), async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const { email, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await prisma.user.create({ data: { email: email.toLowerCase(), passwordHash } });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'An account with that email already exists — sign in instead' });
    }
    console.error('[auth] register failed:', err);
    return res.status(500).json({ error: 'Could not create the account' });
  }
  await logEvent({ level: 'success', message: `Operator account created (${user.email})`, userId: user.id });
  const token = signToken(user.id, user.email);
  res.status(201).json({ token, user: { id: user.id, email: user.email } });
});

/** Login. */
authRouter.post('/login', rateLimit(60_000, 10, 'login'), async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password' });
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  const token = signToken(user.id, user.email);
  await logEvent({ level: 'info', message: `Signed in (${user.email})`, userId: user.id });
  res.json({ token, user: { id: user.id, email: user.email } });
});

/** Forgot Password — generates a reset token, saves it with 1-hour expiration. */
authRouter.post('/forgot-password', async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email' });

  const { email } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    // Don't leak whether an email exists; return success to avoid enumeration
    return res.status(200).json({ message: 'If an account with that email exists, a reset link has been sent.' });
  }

  // Generate a secure, random reset token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiration

  try {
    // Save the token and expiration to the user's profile
    // Assuming we have a setting or field to store the reset token; 
    // if not, we use a simple approach with a Setting table or update passwordReset field
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: resetToken, passwordResetExpires: expiresAt },
    });
  } catch (err: any) {
    console.error('[auth] forgot-password database error:', err);
    return res.status(500).json({ error: 'Could not process the reset request' });
  }

  // Log the reset URL for testing (without sending email)
  const resetUrl = `${process.env.PUBLIC_URL || 'http://localhost:4000'}/reset-password?token=${resetToken}`;
  console.log(`[auth] Password reset token generated for ${email}: ${resetUrl}`);
  console.log('[auth] Please test this URL manually or set up an email provider.');

  res.status(200).json({ message: 'If an account with that email exists, a reset link has been sent.', resetUrl: resetUrl });
});

/** Reset Password — verifies token, hashes new password, updates database. */
authRouter.post('/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request data' });

  const { token, newPassword } = parsed.data;

  // Find user by reset token and verify it hasn't expired
  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: token,
      passwordResetExpires: { gt: new Date() }, // token not expired
    },
  });

  if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    // Update the password and clear the reset token
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetToken: null, passwordResetExpires: null },
    });
    await logEvent({ level: 'success', message: `Password reset for (${user.email})`, userId: user.id });
    const token = signToken(user.id, user.email);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err: any) {
    console.error('[auth] reset-password failed:', err);
    return res.status(500).json({ error: 'Could not reset the password' });
  }
});

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

/** Everything the onboarding wizard needs (§4.1) — zero accounts on a fresh install. */
authRouter.get('/onboarding', requireAuth, async (req: AuthedRequest, res) => {
  const [accounts, aiRaw] = await Promise.all([
    prisma.account.findMany({ where: { userId: req.userId } }),
    prisma.setting.findUnique({ where: { userId_key: { userId: req.userId!, key: 'ai' } } }),
  ]);
  let aiConfigured = false;
  if (aiRaw) {
    try {
      const parsed = JSON.parse(aiRaw.value);
      aiConfigured = parsed.provider === 'ollama' ? true : Boolean(parsed.apiKey);
    } catch {
      aiConfigured = false;
    }
  }
  res.json({
    instagram: accounts.some((a) => a.platform === 'INSTAGRAM' && a.status !== 'DISCONNECTED'),
    whatsapp: accounts.some((a) => a.platform === 'WHATSAPP' && a.status !== 'DISCONNECTED'),
    aiConfigured,
    totalAccounts: accounts.length,
  });
});