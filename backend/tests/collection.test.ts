import { describe, expect, it } from 'vitest';
import { normalizeProbe, type ProbeResult } from '../src/collection/once.js';
import { MemoryStore } from '../src/store/memory.js';
import { createSeed } from '../src/store/seed.js';
import { validateModel } from '../src/models/contract.js';
import type { State } from '../src/models/types.js';

const now = Date.parse('2026-10-24T00:00:00Z');

describe('real snapshot mode', () => {
  it('keeps historical samples visible and never refreshes their acquisition time', () => {
    const seed = createSeed(now);
    seed.sessions = [{ ...seed.sessions[1], status: 'read', activityAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:00:00Z' }];
    const store = new MemoryStore(() => now + 60000, seed, { collectedAt: new Date(now).toISOString(), warnings: [] });
    expect(store.getDashboard().projects[0].sessions).toHaveLength(1);
    expect(store.getDashboard().projects[0].sessions[0].freshness).toBe('stale');
    store.requestRefresh();
    expect(store.getHosts().hosts[0].lastSuccessAt).toBe(new Date(now).toISOString());
    expect(store.getDashboard().sampledAt).toBe(new Date(now).toISOString());
    expect(store.mode).toBe('real-snapshot');
    expect(() => store.addHost('some-host')).toThrow();
    expect(() => store.removeHost('demo-dev')).toThrow();
    expect(validateModel('Dashboard', store.getDashboard())).toBe(true);
    store.close();
  });

  it('separates workspace and storage hosts and validates every imported session', () => {
    const seed = createSeed(now);
    const { id, projectId, hostId, storageHostId, ...fields } = seed.sessions[1];
    const raw = { ...fields, nativeId: 'native', workspaceHost: 'nb-11257', commonDir: null };
    const probe: ProbeResult = { observedAt: new Date(now).toISOString(), sessions: [raw], diagnostics: {} };
    const state: State = { projects: [], sessions: [], hosts: [], candidates: [] };
    expect(normalizeProbe('local', probe, state)).toBe(0);
    expect(state.sessions[0]).toMatchObject({ hostId: 'nb-11257', storageHostId: 'local' });
    expect(validateModel('Session', state.sessions[0])).toBe(true);
    probe.sessions[0].workspaceHost = 'unrecognized-alias';
    normalizeProbe('local', probe, state);
    expect(state.sessions[1].hostId).toBeNull();
  });
});
