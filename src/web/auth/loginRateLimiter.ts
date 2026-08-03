export interface LoginRateLimiterOptions {
  maxAttempts: number
  lockoutMs: number
  now?: () => number
}

export interface LoginAttemptStatus {
  allowed: boolean
  retryAfterMs: number
}

export interface LoginFailureStatus {
  locked: boolean
  retryAfterMs: number
}

interface AttemptRecord {
  failures: number
  lastFailureAt: number
  lockedUntil?: number
}

/** In-memory, per-IP limiter for failed web login attempts. */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>()
  private readonly maxAttempts: number
  private readonly lockoutMs: number
  private readonly now: () => number

  constructor(options: LoginRateLimiterOptions) {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      throw new Error('Login maxAttempts must be a positive integer.')
    }
    if (!Number.isSafeInteger(options.lockoutMs) || options.lockoutMs <= 0) {
      throw new Error('Login lockoutMs must be a positive integer.')
    }
    this.maxAttempts = options.maxAttempts
    this.lockoutMs = options.lockoutMs
    this.now = options.now ?? Date.now
  }

  check(ip: string): LoginAttemptStatus {
    const now = this.now()
    const record = this.currentRecord(ip, now)
    if (!record?.lockedUntil) return { allowed: true, retryAfterMs: 0 }

    return { allowed: false, retryAfterMs: Math.max(1, record.lockedUntil - now) }
  }

  recordFailure(ip: string): LoginFailureStatus {
    const now = this.now()
    const existing = this.currentRecord(ip, now)
    if (existing?.lockedUntil) {
      return { locked: true, retryAfterMs: Math.max(1, existing.lockedUntil - now) }
    }

    const failures = (existing?.failures ?? 0) + 1
    const record: AttemptRecord = { failures, lastFailureAt: now }
    if (failures >= this.maxAttempts) record.lockedUntil = now + this.lockoutMs
    this.attempts.set(ip, record)

    return record.lockedUntil
      ? { locked: true, retryAfterMs: this.lockoutMs }
      : { locked: false, retryAfterMs: 0 }
  }

  recordSuccess(ip: string): void {
    this.attempts.delete(ip)
  }

  reset(ip: string): void {
    this.attempts.delete(ip)
  }

  cleanup(): void {
    const now = this.now()
    for (const [ip] of this.attempts) this.currentRecord(ip, now)
  }

  private currentRecord(ip: string, now: number): AttemptRecord | undefined {
    const record = this.attempts.get(ip)
    if (!record) return undefined

    const lockExpired = record.lockedUntil !== undefined && record.lockedUntil <= now
    const failuresExpired = record.lockedUntil === undefined && record.lastFailureAt + this.lockoutMs <= now
    if (lockExpired || failuresExpired) {
      this.attempts.delete(ip)
      return undefined
    }
    return record
  }
}
