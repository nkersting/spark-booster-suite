import { useState, useEffect } from 'react';
import { useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { KeyRound } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

import { TryFreeModal } from '@/components/TryFreeModal';
import { CHECKOUT_URLS, SUPPORT_EMAIL } from '@/config/pricing';
import { hasRole } from '@/lib/roles';

const BACKDOOR_CODE = 'create';
const MUSEUM_BACKDOOR_CODE = 'museum';
const MET_BACKDOOR_CODE = 'met';
const STORAGE_KEY = 'app-authenticated';
const MUSEUM_MODE_KEY = 'museum-mode';
const MET_MODE_KEY = 'met-mode';
const PASSWORD_RECOVERY_FLAG_KEY = 'pw-recovery';

const isAccessCountOnlyLicense = (lic: {
  tier: string | null;
  max_users: number | null;
  max_sessions: number | null;
}) => {
  const tier = (lic.tier ?? '').toLowerCase();
  return (
    ['test', 'try', 'try10', 'try_10x', '10x'].includes(tier) ||
    (lic.max_sessions !== null && lic.max_sessions >= 10 && (lic.max_users ?? 1) <= 1)
  );
};

interface PasswordGateProps {
  children: React.ReactNode;
}

type GateStep =
  | { kind: 'code' }
  | { kind: 'email'; code: string }
  | { kind: 'sessions_exhausted' };

export function PasswordGate({ children }: PasswordGateProps) {
  const [isCodeAuthenticated, setIsCodeAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<GateStep>({ kind: 'code' });
  const [licenseEmail, setLicenseEmail] = useState('');
  const [tryFreeOpen, setTryFreeOpen] = useState(false);
  const [staffAccess, setStaffAccess] = useState<'unknown' | 'allowed' | 'denied'>('unknown');
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();

  const isAuthRoute = location.pathname === '/auth' || location.pathname.startsWith('/auth/');
  const isPlansRoute = location.pathname === '/plans';

  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored === 'true') setIsCodeAuthenticated(true);
    setIsLoading(false);
  }, []);

  // Authenticated users may only bypass the paywall if they are admin or beta-user.
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setStaffAccess('unknown');
      return;
    }
    (async () => {
      const [isAdmin, isBeta] = await Promise.all([
        hasRole(user.id, 'admin'),
        hasRole(user.id, 'beta-user'),
      ]);
      if (cancelled) return;
      setStaffAccess(isAdmin || isBeta ? 'allowed' : 'denied');
      if (!(isAdmin || isBeta)) {
        // Drop the session so the gate is shown cleanly.
        await supabase.auth.signOut();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const code = password.trim();
    if (!code) return;

    // Backdoor: "create" always grants full access. Do not remove.
    let isAccessCode = false;
    if (/^[A-Za-z0-9]{2}-[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(code)) {
      const { data } = await supabase.rpc('check_access_code', { _code: code });
      isAccessCode = data === true;
    }
    if (code === BACKDOOR_CODE || isAccessCode) {
      sessionStorage.removeItem(MUSEUM_MODE_KEY);
      sessionStorage.removeItem(MET_MODE_KEY);
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setIsCodeAuthenticated(true);
      return;
    }

    // Backdoor: "museum" grants access to the British Museum workflow only.
    if (code === MUSEUM_BACKDOOR_CODE) {
      sessionStorage.removeItem(MET_MODE_KEY);
      sessionStorage.setItem(MUSEUM_MODE_KEY, 'true');
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setIsCodeAuthenticated(true);
      return;
    }

    // Backdoor: "MET" loads the preloaded MET collection only.
    if (code.toLowerCase() === MET_BACKDOOR_CODE) {
      sessionStorage.removeItem(MUSEUM_MODE_KEY);
      sessionStorage.setItem(MET_MODE_KEY, 'true');
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setIsCodeAuthenticated(true);
      return;
    }

    setSubmitting(true);
    try {
      const { data: lic, error } = await supabase
        .from('licenses')
        .select('code,tier,max_users,max_sessions,sessions_used,active_users,active')
        .eq('code', code)
        .maybeSingle();

      if (error || !lic || !lic.active) {
        setErrorMsg(
          `Invalid or inactive license key. Please check your purchase confirmation email or contact support at ${SUPPORT_EMAIL}.`,
        );
        return;
      }
      const countsSessions = lic.max_sessions !== null;
      const enforcesUsers = !isAccessCountOnlyLicense(lic);
      if (countsSessions && lic.sessions_used >= lic.max_sessions) {
        setStep({ kind: 'sessions_exhausted' });
        return;
      }
      if (enforcesUsers && lic.active_users >= lic.max_users) {
        setErrorMsg(
          `This license has reached its maximum number of users. Please contact support at ${SUPPORT_EMAIL}.`,
        );
        return;
      }
      setStep({ kind: 'email', code });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'email') return;
    setErrorMsg(null);
    const email = licenseEmail.trim();
    if (!email) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('redeem_license', {
        _code: step.code,
        _email: email,
      });
      if (error) throw error;
      const result = data as { ok: boolean; reason?: string };
      if (!result?.ok) {
        if (result?.reason === 'sessions_exhausted') {
          setStep({ kind: 'sessions_exhausted' });
          return;
        }
        if (result?.reason === 'max_users') {
          setErrorMsg(
            `This license has reached its maximum number of users. Please contact support at ${SUPPORT_EMAIL}.`,
          );
          return;
        }
        setErrorMsg(
          `Invalid or inactive license key. Please check your purchase confirmation email or contact support at ${SUPPORT_EMAIL}.`,
        );
        return;
      }
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setIsCodeAuthenticated(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (isAuthRoute || isPlansRoute) return <>{children}</>;

  try {
    if (sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY) === 'true') {
      return <Navigate to="/auth" replace />;
    }
  } catch {
    // ignore
  }

  if (user && staffAccess === 'allowed') return <>{children}</>;
  if (user && staffAccess === 'unknown') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (isCodeAuthenticated) return <>{children}</>;

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Welcome to DynamicTree</h1>
          <div className="flex justify-center pt-2">
            <a
              href="/plans"
              className="inline-flex items-center justify-center rounded bg-sky-200 px-3 py-1 text-xs font-semibold text-sky-950 shadow-sm transition-colors hover:bg-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Subscription Plans
            </a>
          </div>
        </div>

        <div className="border-t border-border" />



        <div className="max-w-sm mx-auto">
          {step.kind === 'code' && (
            <form onSubmit={handleCodeSubmit} className="space-y-4">
              <div className="flex flex-col items-center gap-3 mb-2">
                <div className="p-3 rounded-full bg-muted">
                  <KeyRound className="w-6 h-6 text-muted-foreground" />
                </div>
                <h2 className="text-base font-semibold text-foreground">Enter License #</h2>
              </div>
              <Input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setErrorMsg(null);
                }}
                placeholder="License #"
                className={errorMsg ? 'border-destructive' : ''}
                autoFocus
              />
              {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Checking…' : 'Continue'}
              </Button>
              <div className="pt-2 text-center">
                <a
                  href="/auth"
                  className="inline-flex items-center justify-center rounded bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Admin/Beta log in
                </a>
              </div>
            </form>
          )}

          {step.kind === 'email' && (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <h2 className="text-base font-semibold text-foreground text-center">
                Enter your email to continue
              </h2>
              <p className="text-xs text-muted-foreground text-center">
                We use this to associate the session with your license.
              </p>
              <Input
                type="email"
                required
                autoFocus
                placeholder="you@example.com"
                value={licenseEmail}
                onChange={(e) => {
                  setLicenseEmail(e.target.value);
                  setErrorMsg(null);
                }}
              />
              {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Verifying…' : 'Continue'}
              </Button>
              <button
                type="button"
                className="block mx-auto text-xs text-muted-foreground hover:underline"
                onClick={() => {
                  setStep({ kind: 'code' });
                  setLicenseEmail('');
                  setErrorMsg(null);
                }}
              >
                Use a different license #
              </button>
            </form>
          )}

          {step.kind === 'sessions_exhausted' && (
            <div className="space-y-3 text-center">
              <h2 className="text-base font-semibold text-foreground">
                Your sessions have been used up. Upgrade to keep going:
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(['solo', 'team', 'org'] as const).map((t) => {
                  const labels: Record<typeof t, string> = {
                    solo: 'Solo — $79',
                    team: 'Team — $199',
                    org: 'Organization — $499',
                  };
                  const url = CHECKOUT_URLS[t];
                  const disabled = !url || url.startsWith('TODO_');
                  return disabled ? (
                    <Button key={t} disabled variant="outline">{labels[t]}</Button>
                  ) : (
                    <a key={t} href={url} target="_blank" rel="noopener noreferrer">
                      <Button className="w-full">{labels[t]}</Button>
                    </a>
                  );
                })}
              </div>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => {
                  setStep({ kind: 'code' });
                  setPassword('');
                  setErrorMsg(null);
                }}
              >
                Enter a different license #
              </button>
            </div>
          )}
        </div>
      </div>

      <TryFreeModal open={tryFreeOpen} onOpenChange={setTryFreeOpen} />
    </div>
  );
}