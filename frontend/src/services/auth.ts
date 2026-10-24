import * as api from './generated/board';
import { setAccessToken } from './token';

export async function login(username: string, password: string) {
  const result = await api.login({ username, password });
  setAccessToken(result.accessToken);
  return result;
}

export async function logout() {
  try { await api.logout(); }
  finally { setAccessToken(null); }
}
