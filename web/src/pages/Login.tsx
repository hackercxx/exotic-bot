import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { LockKey, EnvelopeSimple, UserPlus, SignIn, InstagramLogo, WhatsappLogo } from '@phosphor-icons/react';
import { useAuth } from '../lib/auth';
import { AmbientBackground } from '../components/AmbientBackground';
import { Button, Field, Input } from '../components/ui';
import { useNavigate } from 'react-router-dom';

type Mode = 'signin' | 'register' | 'forgot' | 'reset';

/** Landing screen: choose Create account or Sign in (§4.1). A fresh install
 * defaults to account creation; a running instance defaults to sign-in, and
 * both stay reachable via the toggle whenever the server allows sign-ups.
 */
export function Login() {
  const { login, register, needsSetup, allowRegistration } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>(needsSetup || !allowRegistration ? 'register' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotBusy, setForgotBusy] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const canRegister = allowRegistration || needsSetup;
  const isRegister = mode === 'register' && canRegister;
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';

  const switchMode = (next: Mode) => {
    if (next === 'register' && !canRegister) return;
    if (next === 'signin' && isForgot) {
      // After forgot flow, go back to signin
      setMode('signin');
      setError(null);
      setForgotError(null);
      setForgotEmail('');
      setResetToken('');
      setNewPassword('');
      setResetError(null);
      return;
    }
    setMode(next);
    setError(null);
    setForgotError(null);
    setResetError(null);
    setNewPassword('');
    setResetToken('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setForgotError(null);
    setResetError(null);
    setBusy(true);
    try {
      if (isRegister) await register(email, password);
      else if (isForgot) await forgotPassword();
      else await login(email, password);
      window.location.href = '/onboarding';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const forgotPassword = async () => {
    setForgotBusy(true);
    setForgotError(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setForgotError(data.error || 'Failed to process forgot password request');
        return;
      }
      // Show the reset link and switch to reset mode
      setResetToken(data.resetUrl?.split('token=')[1] || '');
      setMode('reset');
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : 'Failed to process request');
    } finally {
      setForgotBusy(false);
    }
  };

  const resetPassword = async () => {
    setResetBusy(true);
    setResetError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResetError(data.error || 'Failed to reset password');
        return;
      }
      // Login after reset and navigate
      await login(data.user.email, data.newPassword);
      navigate('/onboarding');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <AmbientBackground />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="glass relative z-10 w-full max-w-md p-8"
      >
        <div className="mb-6 flex items-center gap-3">
          <img src="/icon.svg" alt="EXOTIC BOT" className="h-11 w-11 rounded-xl shadow-glow-violet" />
          <div>
            <div className="font-display text-lg font-semibold text-white">EXOTIC BOT</div>
            <div className="text-xs text-slate-400">
              {needsSetup ? 'First run — create the operator account' : 'Command Center'}
            </div>
          </div>
        </div>

        {canRegister && (
          <div>
            <div role="tablist" aria-label="Authentication" className="mb-6 grid grid-cols-2 gap-1 rounded-[11px] border border-white/10 bg-white/[0.03] p-1">
              <button
                type="button"
                role="tab"
                aria-selected={!isRegister && !isForgot && !isReset}
                onClick={() => switchMode('signin')}
                className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${!isRegister && !isForgot && !isReset ? 'bg-red-500/15 text-white shadow-[inset_0_0_0_1px_rgba(229,25,45,0.35)]' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <SignIn size={15} /> Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isRegister}
                onClick={() => switchMode('register')}
                className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${isRegister ? 'bg-red-500/15 text-white shadow-[inset_0_0_0_1px_rgba(229,25,45,0.35)]' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <UserPlus size={15} /> Create account
              </button>
            </div>
          </div>
        )}

        <div className="mb-5 flex items-center gap-2 rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-slate-400">
          <InstagramLogo size={13} className="text-pink-300" />
          <WhatsappLogo size={13} className="text-emerald-300" />
          Instagram + WhatsApp automation in one command center
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <div className="relative">
              <EnvelopeSimple size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                type="email"
                required
                autoComplete="email"
                placeholder="operator@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="!pl-9"
              />
            </div>
          </Field>

          {isForgot && (
            <Field label="Forgot Password?">
              <div className="relative">
                <EnvelopeSimple size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <Input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="Enter your email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  className="!pl-9"
                />
                <button
                  type="button"
                  onClick={() => submit({ preventDefault: () => {} } as FormEvent)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-blue-400 hover:text-blue-300"
                >
                  Send reset link
                </button>
              </div>
            </Field>
          )}

          {isReset && (
            <Field label="Reset Password">
              <div className="relative">
                <LockKey size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <Input
                  type="password"
                  required
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="!pl-9"
                />
                <input
                  type="hidden"
                  name="token"
                  value={resetToken}
                />
              </div>
            </Field>
          )}

          {isReset && (
            <Field label="" hint="Enter the reset token from the email link">
              <p className="text-xs text-slate-500 mt-1">If you received a reset link via email, enter the token here.</p>
              <input
                type="text"
                placeholder="reset-token"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                className="!pl-9 w-full"
              />
            </Field>
          )}

          {error && (
            <div className="rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {forgotError && (
            <div className="rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {forgotError}
            </div>
          )}

          {resetError && (
            <div className="rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {resetError}
            </div>
          )}

          <Button type="submit" loading={busy} className="w-full !py-2.5">
            {isRegister ? (
              <>
                <UserPlus size={15} /> Create account & continue
              </>
            ) : isForgot ? (
              <>
                <EnvelopeSimple size={15} /> Send reset link
              </>
            ) : isReset ? (
              <>
                <LockKey size={15} /> Reset password
              </>
            ) : (
              <>
                <SignIn size={15} /> Sign in
              </>
            )}
          </Button>
        </form>

        <p className="mt-5 text-center text-xs leading-relaxed text-slate-500">
          {isRegister
            ? 'New operators start with a clean slate — no demo data, ever'
            : isForgot
              ? 'Enter your email to receive a password reset link'
              : isReset
                ? 'Enter the reset token and new password'
                : 'JWT session · encrypted credentials · audited actions'}
        </p>
      </motion.div>
    </div>
  );
}