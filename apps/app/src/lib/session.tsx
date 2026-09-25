/**
 * Who is signed in, which workspace, which Page they are looking at.
 *
 * Almost every endpoint is scoped to a `connectedAccountId`, so the selected
 * Page is application state, not per-screen state — switching Pages in the
 * header has to change the inbox, the automations list and the AI settings at
 * once. It lives here, persisted, with one rule: if the stored id is not in the
 * workspace any more, fall back to the first Page rather than 404 every screen.
 */
import * as React from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { hasFeature, type Feature } from '@leadwave/shared';
import type { AuthMe, ConnectedAccount, Me } from '@/types';

const STORAGE_KEY = 'leadwave.activePageId';

interface SessionValue {
  auth: AuthMe;
  me: Me;
  accounts: ConnectedAccount[];
  activeAccount: ConnectedAccount | null;
  activeAccountId: string | null;
  setActiveAccountId: (id: string) => void;
  /** Plan gate. The API enforces the same table; this only decides what to show. */
  can: (feature: Feature) => boolean;
  refresh: () => Promise<void>;
}

const SessionContext = React.createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/** The selected Page, for the many screens that cannot render without one. */
export function useActiveAccountId(): string | null {
  return useSession().activeAccountId;
}

export function useAuthQuery(): UseQueryResult<AuthMe | null, Error> {
  return useQuery({
    queryKey: ['auth', 'me'],
    retry: false,
    queryFn: async () => {
      try {
        return await api.get<AuthMe>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({
  auth,
  me,
  children,
}: {
  auth: AuthMe;
  me: Me;
  children: React.ReactNode;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const accounts = me.connectedAccounts;

  const [storedId, setStoredId] = React.useState<string | null>(readStored);

  const activeAccount =
    accounts.find((account) => account.id === storedId) ?? accounts[0] ?? null;

  const setActiveAccountId = React.useCallback(
    (id: string) => {
      setStoredId(id);
      try {
        window.localStorage.setItem(STORAGE_KEY, id);
      } catch {
        // Private browsing; the fallback to the first Page is good enough.
      }
      // Everything below the header is scoped to the Page, so drop it all.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const value = React.useMemo<SessionValue>(
    () => ({
      auth,
      me,
      accounts,
      activeAccount,
      activeAccountId: activeAccount?.id ?? null,
      setActiveAccountId,
      can: (feature: Feature) => hasFeature(me.workspace.plan, feature),
      refresh: async () => {
        await queryClient.invalidateQueries({ queryKey: ['accounts', 'me'] });
      },
    }),
    [auth, me, accounts, activeAccount, setActiveAccountId, queryClient],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
