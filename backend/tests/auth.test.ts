import { beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

const password = 'test-only-long-password';

describe('passwords and bearer tokens', () => {
  let auth: AuthService;
  let now = Date.parse('2026-10-24T10:00:00Z');
  beforeAll(async () => { auth = await AuthService.create('admin', password, () => now, 1000); });

  it('salts hashes and verifies without storing clear text', async () => {
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword('incorrect', first)).toBe(false);
    expect(await verifyPassword(password, 'broken')).toBe(false);
  });

  it('rejects unsafe startup credentials', async () => {
    await expect(AuthService.create('admin', 'short')).rejects.toThrow();
  });

  it('accepts the explicitly requested local preview default admin password', async () => {
    const preview = await AuthService.create('admin', 'admin');
    const result = await preview.login('admin', 'admin');
    expect(preview.authenticate('Bearer ' + result.accessToken)).toBe(result.accessToken);
    await expect(preview.login('admin', 'wrong')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('uses identical credential failures for unknown user and wrong password', async () => {
    await expect(auth.login('other', password)).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    await expect(auth.login('admin', 'bad')).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('issues unique tokens, supports revocation and exact expiry', async () => {
    const first = await auth.login('admin', password);
    const second = await auth.login('admin', password);
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(auth.authenticate('Bearer ' + first.accessToken)).toBe(first.accessToken);
    auth.logout('Bearer ' + first.accessToken);
    expect(() => auth.authenticate('Bearer ' + first.accessToken)).toThrow();
    expect(auth.authenticate('bearer ' + second.accessToken)).toBe(second.accessToken);
    now += 1000;
    expect(() => auth.authenticate('Bearer ' + second.accessToken)).toThrow();
    expect(() => auth.authenticate()).toThrow();
    expect(() => auth.authenticate('Basic anything')).toThrow();
  });
});
