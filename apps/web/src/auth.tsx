import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const API_TOKEN_KEY = 'cpm.apiToken';
const CUBE_TOKEN_KEY = 'cpm.cubeToken';

interface AuthContextValue {
  token: string | null;
  cubeToken: string | null;
  connect: (token: string, cubeToken?: string | null) => void;
  setCubeToken: (token: string | null) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(API_TOKEN_KEY));
  const [cubeToken, setCubeTokenState] = useState<string | null>(() =>
    sessionStorage.getItem(CUBE_TOKEN_KEY)
  );

  const connect = useCallback((nextToken: string, nextCubeToken?: string | null) => {
    const clean = nextToken.trim();
    sessionStorage.setItem(API_TOKEN_KEY, clean);
    setToken(clean);
    if (nextCubeToken !== undefined) {
      const cleanCube = nextCubeToken?.trim() ?? '';
      if (cleanCube) sessionStorage.setItem(CUBE_TOKEN_KEY, cleanCube);
      else sessionStorage.removeItem(CUBE_TOKEN_KEY);
      setCubeTokenState(cleanCube || null);
    }
    queryClient.clear();
  }, [queryClient]);

  const setCubeToken = useCallback((next: string | null) => {
    if (next) sessionStorage.setItem(CUBE_TOKEN_KEY, next);
    else sessionStorage.removeItem(CUBE_TOKEN_KEY);
    setCubeTokenState(next);
    queryClient.removeQueries({ queryKey: ['cube-variance'] });
  }, [queryClient]);

  const signOut = useCallback(() => {
    sessionStorage.removeItem(API_TOKEN_KEY);
    sessionStorage.removeItem(CUBE_TOKEN_KEY);
    setToken(null);
    setCubeTokenState(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo(
    () => ({ token, cubeToken, connect, setCubeToken, signOut }),
    [token, cubeToken, connect, setCubeToken, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
