import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardService } from '../services';

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function useBoard(service: BoardService, includeHistory = false) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['board', includeHistory],
    queryFn: async ({ signal }) => {
      const [dashboard, settings] = await Promise.all([service.getDashboard(signal, includeHistory), service.getHosts(signal)]);
      return { dashboard, settings };
    },
    refetchInterval: 15_000,
  });
  const reload = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ['board'] });
  }, [client]);
  const mutation = useMutation({ mutationFn: (action: () => Promise<unknown>) => action(), onSuccess: reload });
  const locked = useRef(false);
  const mutate = mutation.mutateAsync;
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (locked.current) return false;
    locked.current = true;
    try { await mutate(action); return true; }
    catch { return false; }
    finally { locked.current = false; }
  }, [mutate]);
  return {
    dashboard: query.data?.dashboard ?? null,
    settings: query.data?.settings ?? { hosts: [], candidates: [] },
    loadError: query.error ? errorMessage(query.error) : null,
    actionError: mutation.error ? errorMessage(mutation.error) : null,
    busy: mutation.isPending, reload, run,
  };
}
