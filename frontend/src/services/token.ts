let accessToken: string | null = null;
const listeners = new Set<() => void>();

export function getAccessToken() { return accessToken; }
export function setAccessToken(token: string | null) {
  accessToken = token;
  for (const listener of listeners) listener();
}
export function subscribeToken(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
