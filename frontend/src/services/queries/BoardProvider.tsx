import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAccessToken, subscribeToken } from '../token';

export function BoardProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 60_000 },
    mutations: { retry: false },
  } }));
  useEffect(() => {
    const unsubscribe = subscribeToken(() => { if (!getAccessToken()) { void client.cancelQueries(); client.clear(); } });
    return () => { unsubscribe(); void client.cancelQueries(); client.clear(); };
  }, [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
