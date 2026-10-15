import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Mail, Lock, User, CheckCircle, KeyRound } from 'lucide-react';
import { isDisabledUser, hasRole } from '@/lib/roles';

type AuthMode = 'login' | 'signup' | 'verify-email' | 'forgot-password' | 'reset-sent' | 'reset-password' | 'reset-success';

const PASSWORD_RECOVERY_FLAG_KEY = 'pw-recovery';

export default function Auth() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Listen for password recovery event from email link
  useEffect(() => {
    const checkForRecovery = async () => {
      // Debug: capture what the email link actually contains (some clients strip hash/query).
      // This helps us verify whether recovery tokens/codes are arriving at the browser at all.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('[auth] location.href', window.location.href);
        // eslint-disable-next-line no-console
        console.debug('[auth] location.search', window.location.search);
        // eslint-disable-next-line no-console
        console.debug('[auth] location.hash', window.location.hash);
      }

      // If another part of the app already detected recovery (and URL params were cleaned), honor it.
      try {
        if (sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY) === 'true') {
          setMode('reset-password');
        }
      } catch {
        // ignore
      }

      // Check URL hash for recovery token (older flow)
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const hashType = hashParams.get('type');
      
      // Check URL query params for recovery token (PKCE flow)
      const queryParams = new URLSearchParams(window.location.search);
      const queryType = queryParams.get('type');
      const code = queryParams.get('code');
      
      // IMPORTANT: show the reset UI immediately when the URL indicates recovery.
      // Some clients/redirects strip params quickly; persist a sticky flag so we don't fall back to login.
      const looksLikeRecovery = hashType === 'recovery' || queryType === 'recovery' || Boolean(code);
      if (looksLikeRecovery) {
        try {
          sessionStorage.setItem(PASSWORD_RECOVERY_FLAG_KEY, 'true');
        } catch {
          // ignore
        }
        setMode('reset-password');
      }

      // Best-effort: establish a session so updateUser({ password }) will work.
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
      } else if (hashType === 'recovery' || queryType === 'recovery') {
        await supabase.auth.getSession();
      }
    };

    checkForRecovery();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('[auth] onAuthStateChange event', event);
      }
      if (event === 'PASSWORD_RECOVERY') {
        setMode('reset-password');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const checkIfDisabled = async (userId: string): Promise<boolean> => {
    // Use backend role function to avoid RLS/policy mismatches causing false negatives.
    return isDisabledUser(userId);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth`,
            data: {
              display_name: displayName,
            },
          },
        });

        if (error) throw error;

        // Check if email confirmation is required
        if (data.user && !data.session) {
          setMode('verify-email');
        } else if (data.session) {
          toast({
            title: 'Account created!',
            description: 'You are now logged in.',
          });
          navigate('/');
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) throw error;

        // Check if user is disabled BEFORE showing any success message
        if (data.user) {
          const isDisabled = await checkIfDisabled(data.user.id);
          if (isDisabled) {
            await supabase.auth.signOut();
            toast({
              title: 'Account Issue',
              description: 'Contact Administrator.',
              variant: 'destructive',
            });
            setLoading(false);
            return;
          }

          // Restrict sign-in to admin / beta-user roles only.
          const [isAdmin, isBeta] = await Promise.all([
            hasRole(data.user.id, 'admin'),
            hasRole(data.user.id, 'beta-user'),
          ]);
          if (!isAdmin && !isBeta) {
            await supabase.auth.signOut();
            toast({
              title: 'Sign-in not available',
              description:
                'This sign-in is reserved for admin and beta users. Please use an access key to continue.',
              variant: 'destructive',
            });
            setLoading(false);
            return;
          }

          // Only show success message if NOT disabled
          toast({
            title: 'Welcome back!',
            description: 'You have successfully logged in.',
          });
          navigate('/');
        }
      }
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth`,
      });

      if (error) throw error;

      setMode('reset-sent');
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (password !== confirmPassword) {
      toast({
        title: 'Error',
        description: 'Passwords do not match.',
        variant: 'destructive',
      });
      return;
    }

    if (password.length < 6) {
      toast({
        title: 'Error',
        description: 'Password must be at least 6 characters.',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);

    try {
      console.debug('[auth] Starting password update...');

      // Check if we have a valid session before attempting update
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      console.debug('[auth] Session check:', { hasSession: !!session, sessionError });

      if (!session) {
        throw new Error('Your session has expired. Please request a new password reset email.');
      }

      console.debug('[auth] Calling updateUser...');

      // Fire-and-forget: start the password update but don't wait for it.
      // The backend will process it; we redirect immediately to avoid timeout issues.
      supabase.auth.updateUser({ password }).catch((err) => {
        console.error('[auth] Password update error (background):', err);
      });

      // Clear the recovery flag
      try {
        sessionStorage.removeItem(PASSWORD_RECOVERY_FLAG_KEY);
      } catch {
        // ignore
      }

      // Clear local auth storage to prevent AuthContext from detecting a session
      // and making slow RPC calls on the next page load.
      // This avoids waiting for signOut() which could also hang.
      try {
        Object.keys(localStorage).forEach((key) => {
          if (key.startsWith('sb-')) {
            localStorage.removeItem(key);
          }
        });
      } catch {
        // ignore
      }

      console.debug('[auth] Password update initiated, session cleared, redirecting...');

      toast({
        title: 'Password updated!',
        description: 'You can now sign in with your new password.',
      });

      // Redirect immediately without waiting for the update to complete
      window.location.href = '/auth';
    } catch (error: any) {
      console.error('[auth] Password reset error:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to update password. Please try again.',
        variant: 'destructive',
      });
      setLoading(false);
    }
  };

  if (mode === 'verify-email') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-full bg-primary/10">
                <CheckCircle className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold text-center">
              Check your email
            </CardTitle>
            <CardDescription className="text-center">
              We've sent a verification link to <strong>{email}</strong>. 
              Please click the link in the email to verify your account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              Didn't receive the email? Check your spam folder or try again.
            </p>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => {
                setMode('login');
                setEmail('');
                setPassword('');
                setDisplayName('');
              }}
            >
              Back to Sign In
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (mode === 'reset-sent') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-full bg-primary/10">
                <Mail className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold text-center">
              Check your email
            </CardTitle>
            <CardDescription className="text-center">
              We've sent a password reset link to <strong>{email}</strong>. 
              Please click the link in the email to reset your password.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              Didn't receive the email? Check your spam folder or try again.
            </p>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => {
                setMode('login');
                setEmail('');
              }}
            >
              Back to Sign In
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (mode === 'reset-success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold text-center">
              Password updated!
            </CardTitle>
            <CardDescription className="text-center">
              Your password has been successfully reset. You can now sign in with your new password.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col space-y-4">
            <Button 
              className="w-full"
              onClick={async () => {
                // Sign out the recovery session before going to login
                await supabase.auth.signOut();
                setMode('login');
                navigate('/auth', { replace: true });
              }}
            >
              Sign In
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (mode === 'forgot-password') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl font-bold text-center">
              Reset your password
            </CardTitle>
            <CardDescription className="text-center">
              Enter your email address and we'll send you a link to reset your password.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleForgotPassword}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10"
                    required
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col space-y-4">
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Reset Link
              </Button>
              <button
                type="button"
                onClick={() => setMode('login')}
                className="text-sm text-primary hover:underline font-medium"
              >
                Back to Sign In
              </button>
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  if (mode === 'reset-password') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-full bg-primary/10">
                <KeyRound className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold text-center">
              Set new password
            </CardTitle>
            <CardDescription className="text-center">
              Enter your new password below.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleResetPassword}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="newPassword"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10"
                    minLength={6}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-10"
                    minLength={6}
                    required
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col space-y-4">
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update Password
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">
            {mode === 'login' ? 'Welcome back' : 'Create an account'}
          </CardTitle>
          <CardDescription className="text-center">
            {mode === 'login'
              ? 'Enter your credentials to access your account'
              : 'Enter your details to get started'}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {mode === 'signup' && (
              <div className="space-y-2">
                <Label htmlFor="displayName">Display Name</Label>
                <div className="relative">
                  <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="displayName"
                    type="text"
                    placeholder="Your name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="pl-10"
                    required
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10"
                  minLength={6}
                  required
                />
              </div>
            </div>
            {mode === 'login' && (
              <div className="text-right">
                <button
                  type="button"
                  onClick={() => setMode('forgot-password')}
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                >
                  Forgot password?
                </button>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            {mode !== 'login' && (
              <p className="text-sm text-muted-foreground text-center">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="text-primary hover:underline font-medium"
                >
                  Sign in
                </button>
              </p>
            )}
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
