import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import {
  LOG_CATEGORIES,
  LOG_LEVELS,
  type LogCategory,
  type LogEntry,
  type LogLevel
} from '../interfaces/log-entry'
import { isValidInstanceId } from '../config/instancePaths'
import { redactLogData } from '../utils/redaction'

const DAILY_LOG_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1_000
const DEFAULT_DISK_WARN_MB = 500
const DEFAULT_DISK_CHECK_INTERVAL_MS = 60 * 60 * 1_000

export interface LogStoreOptions {
  instanceId: string
  /** Parent directory containing one subdirectory per bot. Defaults to ./logs. */
  rootDir?: string
  diskWarnMb?: number
  diskCheckIntervalMs?: number
  /** Injectable clock used by rotation tests and deterministic callers. */
  now?: () => Date
}

export interface LogReadOptions {
  limit?: number
  /** Opaque cursor returned as nextBefore. ISO timestamps are accepted for compatibility. */
  before?: string
}

export interface LogReadResult {
  /** Chronological order: the oldest returned entry is first. */
  entries: LogEntry[]
  /** Pass this value as `before` to fetch the next, older page. */
  nextBefore?: string
}

export type LogSubscriber = (entry: LogEntry) => void

interface StoredRecord {
  day: string
  line: number
  entry: LogEntry
}

interface DailyLogSource {
  name: string
  compressed: boolean
}

interface DailyLogFile {
  day: string
  /** Archived content first, then any JSONL reopened after a clock rollback. */
  sources: DailyLogSource[]
}

interface FileFingerprint {
  bytes: number
  sha256: string
}

interface LogCursor {
  day: string
  line: number
}

function dayOf(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

function isLogCategory(value: unknown): value is LogCategory {
  return typeof value === 'string' && (LOG_CATEGORIES as readonly string[]).includes(value)
}

function encodeCursor(record: Pick<StoredRecord, 'day' | 'line'>): string {
  return Buffer.from(JSON.stringify({ day: record.day, line: record.line }), 'utf8').toString('base64url')
}

function decodeCursor(value: string): LogCursor | undefined {
  if (!value || value.length > 512) return undefined

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LogCursor>
    if (
      typeof decoded.day === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(decoded.day) &&
      Number.isInteger(decoded.line) &&
      (decoded.line as number) >= 0
    ) {
      return { day: decoded.day, line: decoded.line as number }
    }
  } catch {
    // An ISO timestamp may be supplied instead; the caller handles that path.
  }

  return undefined
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child)
    }
  }
  return value
}

/**
 * Per-instance durable log storage.
 *
 * Writes, reads and rotation share a serial queue. That makes a `before`
 * cursor based on day + physical line stable even while live entries arrive,
 * and prevents readers from observing a half-written JSONL record.
 */
export class LogStore {
  readonly instanceId: string
  readonly directory: string

  private readonly now: () => Date
  private readonly diskWarnBytes: number
  private readonly subscribers = new Set<LogSubscriber>()
  private readonly diskCheckTimer: ReturnType<typeof setInterval> | undefined
  private readonly initialization: Promise<void>
  private rotationTimer: ReturnType<typeof setTimeout> | undefined
  private operation: Promise<unknown>
  private activeDay: string
  private diskWarningActive = false
  private closed = false
  private tempSequence = 0

  constructor(options: LogStoreOptions) {
    if (!isValidInstanceId(options.instanceId)) {
      throw new Error('LogStore instanceId must be 1-32 characters of letters, digits, "_", or "-"')
    }
    if (!Number.isFinite(options.diskWarnMb ?? DEFAULT_DISK_WARN_MB) || (options.diskWarnMb ?? DEFAULT_DISK_WARN_MB) < 0) {
      throw new Error('LogStore diskWarnMb must be a non-negative finite number')
    }
    if (
      !Number.isFinite(options.diskCheckIntervalMs ?? DEFAULT_DISK_CHECK_INTERVAL_MS) ||
      (options.diskCheckIntervalMs ?? DEFAULT_DISK_CHECK_INTERVAL_MS) <= 0
    ) {
      throw new Error('LogStore diskCheckIntervalMs must be a positive finite number')
    }

    this.instanceId = options.instanceId
    this.directory = path.resolve(options.rootDir ?? path.join(process.cwd(), 'logs'), options.instanceId)
    this.now = options.now ?? (() => new Date())
    this.diskWarnBytes = (options.diskWarnMb ?? DEFAULT_DISK_WARN_MB) * 1024 * 1024
    this.activeDay = dayOf(this.now())
    this.initialization = this.initialize()
    // Attach a handler immediately so a filesystem failure cannot become an
    // unhandled rejection before startup has a chance to await ready().
    void this.initialization.catch(() => undefined)
    this.operation = this.initialization
    this.scheduleNextRotation()

    const interval = options.diskCheckIntervalMs ?? DEFAULT_DISK_CHECK_INTERVAL_MS
    this.diskCheckTimer = setInterval(() => {
      void this.checkDiskUsage().catch(() => {
        // A storage monitor must never crash the bot process. A later interval
        // retries; logging the failure through this store would be recursive.
      })
    }, interval)
    this.diskCheckTimer.unref?.()
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const compressedDays = await this.compressClosedDays(this.activeDay)
    const timestamp = this.now()
    for (const day of compressedDays) {
      await this.writeEntry(
        'info',
        'storage',
        'Compressed closed daily log',
        { day, file: `${day}.jsonl.gz` },
        timestamp,
        this.activeDay
      )
    }
  }

  /** Waits until the instance directory and startup compression are ready. */
  async ready(): Promise<void> {
    await this.initialization
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async append(
    level: LogLevel,
    category: LogCategory,
    message: string,
    meta?: Record<string, unknown>
  ): Promise<LogEntry> {
    if (this.closed) throw new Error(`LogStore for ${this.instanceId} is closed`)

    return this.enqueue(async () => {
      if (this.closed) throw new Error(`LogStore for ${this.instanceId} is closed`)

      await fs.mkdir(this.directory, { recursive: true })
      const timestamp = this.now()
      const entryDay = dayOf(timestamp)
      await this.rotateIfNeeded(entryDay, timestamp)
      return this.writeEntry(level, category, String(message), meta, timestamp, entryDay)
    })
  }

  private async writeEntry(
    level: LogLevel,
    category: LogCategory,
    message: string,
    meta: Record<string, unknown> | undefined,
    timestamp: Date,
    fileDay: string
  ): Promise<LogEntry> {
    const redacted = redactLogData(message, meta)
    const entry = freezeDeep<LogEntry>({
      timestamp: timestamp.toISOString(),
      instanceId: this.instanceId,
      level,
      category,
      message: redacted.message,
      meta: redacted.meta
    })

    const filePath = path.join(this.directory, `${fileDay}.jsonl`)
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    this.publish(entry)
    return entry
  }

  private async rotateIfNeeded(entryDay: string, timestamp: Date): Promise<void> {
    if (entryDay === this.activeDay) return

    const previousDay = this.activeDay
    const compressedDays = await this.compressClosedDays(entryDay)
    this.activeDay = entryDay

    await this.writeEntry(
      'info',
      'storage',
      'Rotated to a new daily log',
      { previousDay, currentDay: entryDay },
      timestamp,
      entryDay
    )
    for (const day of compressedDays) {
      await this.writeEntry(
        'info',
        'storage',
        'Compressed closed daily log',
        { day, file: `${day}.jsonl.gz` },
        timestamp,
        entryDay
      )
    }
  }

  async readRecent(options: LogReadOptions = {}): Promise<LogReadResult> {
    const limit = options.limit ?? DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`Log read limit must be an integer between 1 and ${MAX_LIMIT}`)
    }

    return this.enqueue(async () => {
      const cursor = options.before ? decodeCursor(options.before) : undefined
      let beforeTimestamp: number | undefined
      let beforeDay: string | undefined
      if (options.before && !cursor) {
        beforeTimestamp = Date.parse(options.before)
        if (Number.isNaN(beforeTimestamp)) throw new Error('Invalid log cursor')
        beforeDay = dayOf(new Date(beforeTimestamp))
      }

      const files = (await this.listDailyFiles())
        .filter((file) => {
          if (cursor) return file.day <= cursor.day
          if (beforeDay) return file.day <= beforeDay
          return true
        })
        .sort((left, right) => right.day.localeCompare(left.day))

      // Collected newest -> oldest so we can stop immediately once the page
      // is full. Each selected file retains at most the remaining limit + one
      // record in memory; gzip input is decompressed as a stream.
      const newestFirst: StoredRecord[] = []
      let hasMore = false

      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const remaining = limit - newestFirst.length
        const tail = await this.readDayTail(
          files[fileIndex],
          remaining + 1,
          cursor,
          beforeTimestamp
        )
        const dayNewestFirst = tail.reverse()

        if (dayNewestFirst.length > remaining) {
          newestFirst.push(...dayNewestFirst.slice(0, remaining))
          hasMore = true
          break
        }

        newestFirst.push(...dayNewestFirst)
        if (newestFirst.length === limit) {
          // We deliberately do not open unrelated older days just to prove
          // they contain a valid line. A remaining daily file means another
          // page may exist; that page will skip corrupt individual lines.
          hasMore = fileIndex < files.length - 1
          break
        }
      }

      const chronological = newestFirst.reverse()
      return {
        entries: chronological.map((record) => record.entry),
        nextBefore: hasMore && chronological.length > 0
          ? encodeCursor(chronological[0])
          : undefined
      }
    })
  }

  subscribe(subscriber: LogSubscriber): () => void {
    if (this.closed) return () => {}
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private publish(entry: LogEntry): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(entry)
      } catch {
        // One broken SSE client/listener must not block the remaining clients.
      }
    }
  }

  /** Runs the configured per-instance threshold check immediately. */
  async checkDiskUsage(): Promise<number> {
    const sizeBytes = await this.directorySize(this.directory)
    const overThreshold = sizeBytes > this.diskWarnBytes

    if (overThreshold && !this.diskWarningActive && !this.closed) {
      // Set this before appending: the warning itself increases directory size.
      this.diskWarningActive = true
      await this.append(
        'warn',
        'storage',
        'Log directory exceeded the configured disk warning threshold',
        {
          sizeBytes,
          sizeMb: Number((sizeBytes / 1024 / 1024).toFixed(2)),
          thresholdBytes: this.diskWarnBytes,
          thresholdMb: this.diskWarnBytes / 1024 / 1024
        }
      )
    } else if (!overThreshold) {
      this.diskWarningActive = false
    }

    return sizeBytes
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.diskCheckTimer) clearInterval(this.diskCheckTimer)
    if (this.rotationTimer) clearTimeout(this.rotationTimer)
    await this.operation.catch(() => undefined)
    this.subscribers.clear()
  }

  private scheduleNextRotation(): void {
    if (this.closed) return

    const current = this.now()
    const nextMidnight = new Date(current.getTime())
    nextMidnight.setHours(24, 0, 0, 0)
    const delay = Math.max(1_000, nextMidnight.getTime() - current.getTime())

    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = undefined
      const timestamp = this.now()
      void this.enqueue(() => this.rotateIfNeeded(dayOf(timestamp), timestamp))
        .catch(() => {
          // Rotation is retried by the next timer and by the next append.
        })
        .finally(() => this.scheduleNextRotation())
    }, delay)
    this.rotationTimer.unref?.()
  }

  private async compressClosedDays(currentDay: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const candidates = names
      .map((name) => ({ name, match: /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name) }))
      .filter((item): item is { name: string; match: RegExpExecArray } => Boolean(item.match))
      .filter((item) => item.match[1] < currentDay)
      .sort((left, right) => left.match[1].localeCompare(right.match[1]))

    const compressedDays: string[] = []
    for (const candidate of candidates) {
      if (await this.compressFile(path.join(this.directory, candidate.name))) {
        compressedDays.push(candidate.match[1])
      }
    }
    return compressedDays
  }

  private async compressFile(sourcePath: string): Promise<boolean> {
    const targetPath = `${sourcePath}.gz`

    try {
      await fs.access(targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.createCompressedFile(sourcePath, targetPath)
      }
      throw error
    }

    // A target can coexist with JSONL after a crash between atomic rename and
    // source cleanup, but it can also be stale/corrupt or belong to an earlier
    // archive of a date reopened after clock rollback. Delete the source only
    // when streaming validation proves the uncompressed bytes are identical.
    try {
      const archived = await this.fingerprintFile(targetPath, true)
      const source = await this.fingerprintFile(sourcePath, false)
      if (archived.bytes === source.bytes && archived.sha256 === source.sha256) {
        await fs.unlink(sourcePath)
        return true
      }
    } catch {
      // Preserve both files. readRecent surfaces a controlled error if the
      // gzip itself is corrupt; the JSONL remains available for recovery.
    }
    return false
  }

  private async createCompressedFile(sourcePath: string, targetPath: string): Promise<boolean> {
    const tempPath = `${targetPath}.tmp-${process.pid}-${++this.tempSequence}`
    try {
      await pipeline(
        createReadStream(sourcePath),
        createGzip(),
        createWriteStream(tempPath, { flags: 'wx' })
      )
      await fs.rename(tempPath, targetPath)
      await fs.unlink(sourcePath)
      return true
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }

  private async fingerprintFile(filePath: string, compressed: boolean): Promise<FileFingerprint> {
    const source = createReadStream(filePath)
    const decompressor = compressed ? createGunzip() : undefined
    const input = decompressor ?? source
    const hash = createHash('sha256')
    let bytes = 0

    if (decompressor) {
      source.on('error', (error) => decompressor.destroy(error))
      source.pipe(decompressor)
    }

    try {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        hash.update(buffer)
      }
      return { bytes, sha256: hash.digest('hex') }
    } finally {
      input.destroy()
      source.destroy()
    }
  }

  private async listDailyFiles(): Promise<DailyLogFile[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    // A day normally has one source. Both can legitimately remain after a
    // clock rollback reopened an already archived date; retaining both is the
    // lossless fallback when they cannot be proven byte-for-byte equivalent.
    const byDay = new Map<string, DailyLogFile>()
    for (const name of names) {
      const match = DAILY_LOG_PATTERN.exec(name)
      if (!match) continue
      const day = match[1]
      const compressed = Boolean(match[2])
      const file = byDay.get(day) ?? { day, sources: [] }
      file.sources.push({ name, compressed })
      byDay.set(day, file)
    }
    for (const file of byDay.values()) {
      file.sources.sort((left, right) => Number(right.compressed) - Number(left.compressed))
    }
    return [...byDay.values()]
  }

  private async readDayTail(
    file: DailyLogFile,
    maxRecords: number,
    cursor: LogCursor | undefined,
    beforeTimestamp: number | undefined
  ): Promise<StoredRecord[]> {
    const tail = new Array<StoredRecord>(maxRecords)
    let tailStart = 0
    let tailCount = 0
    let lineNumber = 0

    const considerLine = (rawLine: string): void => {
      const physicalLine = lineNumber++
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!line.trim()) return
      if (cursor && file.day === cursor.day && physicalLine >= cursor.line) return

      const entry = this.parseEntry(line)
      if (!entry) return
      if (
        beforeTimestamp !== undefined &&
        !(Date.parse(entry.timestamp) < beforeTimestamp)
      ) {
        return
      }

      const record = { day: file.day, line: physicalLine, entry }
      if (tailCount < maxRecords) {
        tail[(tailStart + tailCount) % maxRecords] = record
        tailCount += 1
      } else {
        tail[tailStart] = record
        tailStart = (tailStart + 1) % maxRecords
      }
    }

    for (const logSource of file.sources) {
      const filePath = path.join(this.directory, logSource.name)
      const source = createReadStream(filePath)
      const decompressor = logSource.compressed ? createGunzip() : undefined
      const input = decompressor ?? source
      let carry = ''

      if (decompressor) {
        // pipe() does not forward source errors, so explicitly turn one into
        // an input error observed by the async iterator below.
        source.on('error', (error) => decompressor.destroy(error))
        source.pipe(decompressor)
      }
      input.setEncoding('utf8')

      try {
        for await (const chunk of input) {
          carry += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          let newline = carry.indexOf('\n')
          while (newline >= 0) {
            considerLine(carry.slice(0, newline))
            carry = carry.slice(newline + 1)
            newline = carry.indexOf('\n')
          }
        }
        if (carry.length > 0) considerLine(carry)
      } catch (error) {
        const kind = logSource.compressed ? 'compressed log file' : 'log file'
        const wrapped = new Error(`Failed to read ${kind} ${logSource.name}`)
        ;(wrapped as Error & { cause?: unknown }).cause = error
        throw wrapped
      } finally {
        input.destroy()
        source.destroy()
      }
    }
    return Array.from(
      { length: tailCount },
      (_, index) => tail[(tailStart + index) % maxRecords]
    )
  }

  private parseEntry(line: string): LogEntry | undefined {
    try {
      const candidate = JSON.parse(line) as Partial<LogEntry>
      if (
        typeof candidate.timestamp !== 'string' ||
        candidate.instanceId !== this.instanceId ||
        !isLogLevel(candidate.level) ||
        !isLogCategory(candidate.category) ||
        typeof candidate.message !== 'string'
      ) {
        return undefined
      }

      // Re-redacting on read also protects the UI from manually imported or
      // legacy JSONL that predates the write gateway.
      const rawMeta = candidate.meta && typeof candidate.meta === 'object' && !Array.isArray(candidate.meta)
        ? candidate.meta as Record<string, unknown>
        : {}
      const redacted = redactLogData(candidate.message, rawMeta)
      return freezeDeep({
        timestamp: candidate.timestamp,
        instanceId: candidate.instanceId,
        level: candidate.level,
        category: candidate.category,
        message: redacted.message,
        meta: redacted.meta
      })
    } catch {
      // A single truncated/corrupt line should not hide otherwise valid history.
      return undefined
    }
  }

  private async directorySize(directory: string): Promise<number> {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }

    let total = 0
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        total += await this.directorySize(entryPath)
      } else if (entry.isFile()) {
        total += (await fs.stat(entryPath)).size
      }
    }
    return total
  }
}
