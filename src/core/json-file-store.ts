// src/core/json-file-store.ts
// Shared primitives for JSON-file-backed stores (permissions, homes, ...): read-with-fallback,
// and atomic (write-temp-then-rename) writes so a crash mid-save can never corrupt the file.

import { promises as fs } from 'fs'
import * as path from 'path'

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback
    throw err
  }
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmpPath, filePath)
}
