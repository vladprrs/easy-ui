import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getMe, logout as logoutRequest, type AuthUser } from "../api/client";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  setUser: (user: AuthUser) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void getMe(controller.signal)
      .then(setUserState)
      .catch(() => setUserState(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const setUser = useCallback((nextUser: AuthUser) => setUserState(nextUser), []);
  const logout = useCallback(async () => {
    await logoutRequest();
    setUserState(null);
  }, []);
  const value = useMemo(() => ({ user, loading, setUser, logout }), [loading, logout, setUser, user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth должен использоваться внутри AuthProvider");
  return value;
}
