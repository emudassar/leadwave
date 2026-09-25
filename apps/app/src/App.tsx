/**
 * Routing and the auth gate.
 *
 * Two queries have to resolve before any screen can render: who you are, and
 * what your workspace allows. Rather than let every page handle "loading" and
 * "signed out" itself, the gate resolves both once and hands the rest of the
 * app a session that is always there.
 */
import * as React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { SessionProvider, useAuthQuery } from '@/lib/session';
import { AppShell } from '@/components/AppShell';
import type { Me } from '@/types';
import { LoginPage } from '@/pages/Login';
import { OnboardingPage } from '@/pages/Onboarding';
import { HomePage } from '@/pages/Home';
import { AutomationsPage } from '@/pages/Automations';
import { AutomationBuilderPage } from '@/pages/AutomationBuilder';
import { InboxPage } from '@/pages/Inbox';
import { ContactsPage } from '@/pages/Contacts';
import { AiPage } from '@/pages/Ai';
import { BioPage } from '@/pages/Bio';
import { BioDesignPage } from '@/pages/BioDesign';
import { SettingsPage } from '@/pages/Settings';
import { AdminPage } from '@/pages/Admin';

function FullScreenLoader(): React.ReactElement {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-3">
        <div className="brand-gradient flex size-10 animate-pulse-ring items-center justify-center rounded-xl">
          <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
            <path
              d="M6 20c3-5 5-5 8 0s5 5 8 0"
              stroke="#fff"
              strokeWidth="2.8"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </div>
        <p className="text-[13px] text-text-subtle">Loading your workspace…</p>
      </div>
    </div>
  );
}

function AuthedRoutes(): React.ReactElement {
  return (
    <AppShell>
      <Routes>
        <Route path="/home" element={<HomePage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/automations/new" element={<AutomationBuilderPage />} />
        <Route path="/automations/:id" element={<AutomationBuilderPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/inbox/:conversationId" element={<InboxPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/ai" element={<AiPage />} />
        <Route path="/ai/:tab" element={<AiPage />} />
        <Route path="/bio" element={<BioPage />} />
        <Route path="/bio/:id/design" element={<BioDesignPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:tab" element={<SettingsPage />} />
        <Route path="/growth" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </AppShell>
  );
}

export function App(): React.ReactElement {
  const location = useLocation();
  const authQuery = useAuthQuery();

  const meQuery = useQuery({
    queryKey: ['accounts', 'me'],
    queryFn: () => api.get<Me>('/accounts/me'),
    enabled: Boolean(authQuery.data?.user),
  });

  if (authQuery.isLoading) return <FullScreenLoader />;

  if (!authQuery.data?.user) {
    // Keep /login itself reachable, and remember where they were headed.
    if (location.pathname === '/login') return <LoginPage />;
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (meQuery.isLoading || !meQuery.data) return <FullScreenLoader />;

  const me = meQuery.data;
  const onboarded = Boolean(me.workspace.onboardedAt) && me.connectedAccounts.length > 0;

  return (
    <SessionProvider auth={authQuery.data} me={me}>
      {location.pathname === '/onboarding' ? (
        <OnboardingPage />
      ) : onboarded ? (
        <AuthedRoutes />
      ) : (
        <Navigate to="/onboarding" replace />
      )}
    </SessionProvider>
  );
}
