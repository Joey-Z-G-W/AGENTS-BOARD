import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from '../models/errors.js';
import { hashPassword, verifyPassword } from './password.js';

interface TokenRecord { username: string; expiresAt: number }

export class AuthService {
  private readonly tokens = new Map<string, TokenRecord>();
  private activeLogins = 0;

  private constructor(
    private readonly username: string,
    private readonly passwordHash: string,
    private readonly now: () => number,
    private readonly tokenTtlMs: number,
  ) {}

  static async create(username: string, password: string, now = Date.now, tokenTtlMs = 3600000) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username) || (password !== 'admin' && password.length < 12) || password.length > 256) {
      throw new Error('BOARD_USERNAME 必须是 1–64 位安全字符；除本机预览默认密码 admin 外，BOARD_PASSWORD 必须是 12–256 位。');
    }
    return new AuthService(username, await hashPassword(password), now, tokenTtlMs);
  }

  private digest(token: string) { return createHash('sha256').update(token).digest('hex'); }

  private prune() {
    for (const [key, record] of this.tokens) {
      if (record.expiresAt <= this.now()) this.tokens.delete(key);
    }
  }

  async login(username: string, password: string) {
    if (this.activeLogins >= 2) throw new ApiError(429, 'RATE_LIMITED', '登录繁忙，请稍后重试。');
    this.activeLogins++;
    try {
      const validPassword = await verifyPassword(password, this.passwordHash);
      if (username !== this.username || !validPassword) throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误。');
      this.prune();
      if (this.tokens.size >= 128) throw new ApiError(429, 'RATE_LIMITED', '有效登录过多，请注销旧会话后重试。');
      const accessToken = randomBytes(32).toString('base64url');
      const expiresAt = this.now() + this.tokenTtlMs;
      this.tokens.set(this.digest(accessToken), { username, expiresAt });
      return { accessToken, tokenType: 'Bearer' as const, expiresAt: new Date(expiresAt).toISOString() };
    } finally { this.activeLogins--; }
  }

  authenticate(header?: string): string {
    this.prune();
    const match = /^Bearer ([a-zA-Z0-9_-]{43})$/i.exec(header ?? '');
    const record = match ? this.tokens.get(this.digest(match[1])) : undefined;
    if (!record) throw new ApiError(401, 'UNAUTHORIZED', '请登录，或登录已过期。');
    return match![1];
  }

  logout(header?: string) {
    this.tokens.delete(this.digest(this.authenticate(header)));
  }
}
