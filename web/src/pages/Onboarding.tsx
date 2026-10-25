import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { InstagramLogo, WhatsappLogo, Sparkle, Check, ArrowRight } from '@phosphor-icons/react';
import { api } from '../lib/api';
import { AmbientBackground } from '../components/AmbientBackground';
import { Button, Field, Input, Select } from '../components/ui';
import { InstagramConnect } from '../components/InstagramConnect';
import { WhatsAppPairing } from '../components/WhatsAppPairing';
import { pushToast } from '../lib/store';
import { analytics } from '../lib/analytics';

interface OnboardingState {
  instagram: boolean;
  whatsapp: boolean;
  aiConfigured: boolean;
  totalAccounts: number;
}

const STEPS = ['Instagram', 'WhatsApp', 'AI engine'] as const;

/**
 * Onboarding wizard (§4.1): connect IG → connect WhatsApp → set AI provider.
 * Fresh instance: zero connected accounts (real state from /auth/onboarding).
 */
export function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'ollama'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [tone, setTone] = useState<'friendly' | 'professional' | 'casual'>('friendly');
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api<OnboardingState>('/auth/onboarding')
      .then(setState)
      .catch(() => undefined);

  const startTracked = useRef(false);
  useEffect(() => {
    if (!startTracked.current) {
      startTracked.current = true;
      analytics.trackSetupWizardStarted();
    }
    refresh();
  }, []);

  const finish = () => {
    localStorage.setItem('exotic.onboarded', '1');
    navigate('/');
  };

  const saveAi = async () => {
    setError(null);
    setAiBusy(true);
    try {
      await api('/settings', { method: 'PUT', body: { ai: { provider, apiKey, tone } } });
      pushToast('success', 'AI reply engine configured');
      await refresh();
      finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setAiBusy(false);
    }
  };

  const done = [state?.instagram, state?.whatsapp, state?.aiConfigured];

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <AmbientBackground />
      <div className="relative z-10 w-full max-w-xl">
        {/* progress */}
        <div className="mb-5 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <button
                onClick={() => setStep(i)}
                className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                  i === step
                    ? 'border-violet-400/50 bg-violet-500/20 text-white'
                    : done[i]
                      ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-white/10 bg-white/5 text-slate-400'
                }`}
              >
                {done[i] ? <Check size={12} /> : <span className="font-mono">{i + 1}</span>}
                {s}
              </button>
              {i < STEPS.length - 1 && <ArrowRight size={12} className="text-slate-600" />}
            </div>
          ))}
        </div>

        <motion.div
          key={step}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="glass p-7"
        >
          <div className="mb-1 font-display text-lg font-semibold text-white">
            {step === 0 && (
              <>
                <InstagramLogo size={19} className="mr-2 inline text-pink-300" />
                Connect Instagram Business
              </>
            )}
            {step === 1 && (
              <>
                <WhatsappLogo size={19} className="mr-2 inline text-emerald-300" />
                Connect WhatsApp Business
              </>
            )}
            {step === 2 && (
              <>
                <Sparkle size={19} className="mr-2 inline text-violet-300" />
                Set your AI reply engine
              </>
            )}
          </div>
          <p className="mb-5 text-sm leading-relaxed text-slate-400">
            {step === 0 &&
              'Type your Instagram handle — official OAuth 2.0 via the Meta Graph API, auto-matched to the Page-linked Business/Creator account with that username.'}
            {step === 1 &&
              'Enter your number and get a genuine WhatsApp pairing code: type it into WhatsApp → Linked devices → Link with phone number. No QR scan, no third-party bridge.'}
            {step === 2 &&
              'Choose a provider. The API key is encrypted at rest (AES-256-GCM) and never shown again. Auto-reply stays OFF until you enable it.'}
          </p>

          <AnimatePresence mode="wait">
            {step === 0 && (
              <div className="space-y-4">
                <InstagramConnect connected={state?.instagram} compact onDone={refresh} />
              </div>
            )}
            {step === 1 && (
              <div className="space-y-4">
                <WhatsAppPairing connected={state?.whatsapp} onDone={() => { void refresh(); setStep(2); }} />
              </div>
            )}
            {step === 2 && (
              <div className="space-y-4">
                <Field label="Provider">
                  <Select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="ollama">Local Ollama (no key needed)</option>
                  </Select>
                </Field>
                {provider !== 'ollama' && (
                  <Field label="API key" hint="Stored encrypted at rest; masked everywhere in the UI.">
                    <Input
                      type="password"
                      placeholder={provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </Field>
                )}
                <Field label="Default reply tone">
                  <Select value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
                    <option value="friendly">Friendly</option>
                    <option value="professional">Professional</option>
                    <option value="casual">Casual</option>
                  </Select>
                </Field>
                <Button onClick={saveAi} loading={aiBusy} className="w-full">
                  Save & finish setup
                </Button>
              </div>
            )}
          </AnimatePresence>

          {error && (
            <div className="mt-4 rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between border-t border-white/[0.07] pt-4">
            <button onClick={finish} className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
              Skip for now
            </button>
            <div className="flex gap-2">
              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              )}
              {step < 2 && (
                <Button variant="ghost" onClick={() => setStep(step + 1)}>
                  Next <ArrowRight size={14} />
                </Button>
              )}
            </div>
          </div>
        </motion.div>

        <p className="mt-4 text-center text-xs text-slate-600">
          {state ? `${state.totalAccounts} account${state.totalAccounts === 1 ? '' : 's'} connected` : ''} · first-run state
          ships with zero demo data
        </p>
      </div>
    </div>
  );
}
