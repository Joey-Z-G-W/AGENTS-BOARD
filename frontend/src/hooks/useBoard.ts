import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardService, Dashboard, HostSettings } from '../services';

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function useBoard(service: BoardService) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<HostSettings>({ hosts: [], candidates: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const operation = useRef(false);

  const reload = useCallback(async () => {
    const current = ++requestId.current;
    try {
      const [nextDashboard, nextSettings] = await Promise.all([service.getDashboard(), service.getHosts()]);
      if (mounted.current && current === requestId.current) {
        setDashboard(nextDashboard);
        setSettings(nextSettings);
        setLoadError(null);
      }
    } catch (error) {
      if (mounted.current && current === requestId.current) setLoadError(errorMessage(error));
    }
  }, [service]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = setInterval(() => void reload(), 15_000);
    return () => {
      mounted.current = false;
      requestId.current++;
      clearInterval(timer);
    };
  }, [reload]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (operation.current) return false;
    operation.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
      return false;
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [reload]);

  return { dashboard, settings, loadError, actionError, busy, reload, run };
}
