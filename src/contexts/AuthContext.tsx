import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { isDisabledUser } from '@/lib/roles';

const PASSWORD_RECOVERY_FLAG_KEY = 'pw-recovery';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  const checkIfDisabled = async (userId: string): Promise<boolean> => {
    // Use backend role function to avoid RLS/policy mismatches causing false negatives.
    return isDisabledUser(userId);
  };

  useEffect(() => {
    // Set up auth state listener BEFORE getting session
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        // If the user arrived via a password recovery link, persist a flag.
        // Some flows clean URL params quickly; this ensures the /auth UI can still show the reset form.
        if (_event === 'PASSWORD_RECOVERY') {
          try {
            sessionStorage.setItem(PASSWORD_RECOVERY_FLAG_KEY, 'true');
          } catch {
            // ignore
          }
        }

        // Check if user is disabled on login
        if (session?.user) {
          const isDisabled = await checkIfDisabled(session.user.id);
          if (isDisabled) {
            await supabase.auth.signOut();
            setSession(null);
            setUser(null);
            setLoading(false);
            toast({
              title: 'Account Issue',
              description: 'Contact Administrator.',
              variant: 'destructive',
            });
            if (location.pathname !== '/auth') {
              navigate('/auth');
            }
            return;
          }
        }
        
        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);
      }
    );

    // Get initial session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const isDisabled = await checkIfDisabled(session.user.id);
        if (isDisabled) {
          await supabase.auth.signOut();
          setSession(null);
          setUser(null);
          setLoading(false);
          return;
        }
      }
      
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [navigate, location.pathname]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
