import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { App } from './App';
import { TooltipProvider } from './components/ui';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Screens are read-mostly and the API is fast; a short stale window keeps
      // the inbox feeling live without hammering it on every tab change.
      staleTime: 15_000,
      retry: (failureCount, error) =>
        failureCount < 2 && !(error as { status?: number }).status,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <App />
          <Toaster
            position="bottom-right"
            toastOptions={{
              className:
                'rounded-lg border border-line bg-surface-raised text-text text-[13px] shadow-[var(--shadow-lift)]',
            }}
          />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
