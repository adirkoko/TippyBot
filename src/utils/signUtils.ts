// src/utils/signUtils.ts
// Utility functions for working with sign text and properties

import { Vec3 } from 'vec3'

/** Remove surrounding double quotes from a string, if present
 * @param s The input value
 * @returns The unwrapped string
 */
export function unwrapDoubleQuotes(s: unknown): string {
  if (typeof s !== 'string') return String(s ?? '')
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

/** Convert a Minecraft chat component to a plain string
 * @param v The chat component
 * @returns The plain string representation
 */
export function toPlainStringFromComponent(v: any): string {
  try {
    if (v == null) return ''
    if (typeof v === 'object') {
      if (Array.isArray(v)) {
        return unwrapDoubleQuotes(
          v.map(toPlainStringFromComponent).join('').trim()
        )
      }
      if ('text' in v) {
        const extras = Array.isArray((v as any).extra)
          ? (v as any).extra.map(toPlainStringFromComponent).join('')
          : ''
        return unwrapDoubleQuotes(String((v as any).text) + extras)
      }
    }

    let s = String(v)
    if (s.startsWith('{') && s.includes('"text"')) {
      try {
        const obj = JSON.parse(s)
        if (obj && typeof obj === 'object' && 'text' in obj) {
          const extras = Array.isArray((obj as any).extra)
            ? (obj as any).extra.map(toPlainStringFromComponent).join('')
            : ''
          return unwrapDoubleQuotes(String((obj as any).text) + extras)
        }
      } catch {
        // ignore JSON parse error
      }
    }
    return unwrapDoubleQuotes(s)
  } catch {
    return unwrapDoubleQuotes(String(v ?? ''))
  }
}

/** Clean and filter an array of strings
 * @param arr The array to clean
 * @returns A cleaned array of strings
 */
export function tidyLines(arr: unknown[]): string[] {
  return (arr || [])
    .map((s) => {
      if (s == null) return ''
      const cleaned = String(s).replace(/§[0-9A-FK-OR]/gi, '').trim()
      if (!cleaned) return ''
      const lower = cleaned.toLowerCase()
      if (lower === 'null' || lower === 'undefined') return ''
      return cleaned
    })
    .filter(Boolean) as string[]
}

/**
 * Extract lines of text from a sign's NBT data
 * @param nbtValue The NBT data of the sign
 * @returns An object containing the front and back lines of text
 */
export function linesFromTileEntityNBT(nbtValue: any): {
  front: string[]
  back: string[]
} {
  const t1 = nbtValue?.Text1?.value
  const t2 = nbtValue?.Text2?.value
  const t3 = nbtValue?.Text3?.value
  const t4 = nbtValue?.Text4?.value

  if (t1 !== undefined || t2 !== undefined || t3 !== undefined || t4 !== undefined) {
    const front = tidyLines([t1, t2, t3, t4].map(toPlainStringFromComponent))
    return { front, back: [] }
  }

  const fPlain = nbtValue?.front_text?.messages
  const bPlain = nbtValue?.back_text?.messages

  if (Array.isArray(fPlain) || Array.isArray(bPlain)) {
    const front = tidyLines((fPlain || []).map(toPlainStringFromComponent))
    const back = tidyLines((bPlain || []).map(toPlainStringFromComponent))
    return { front, back }
  }

  const fTag = nbtValue?.front_text?.value?.messages?.value?.value
  const bTag = nbtValue?.back_text?.value?.messages?.value?.value

  if (Array.isArray(fTag) || Array.isArray(bTag)) {
    const front = tidyLines((fTag || []).map(toPlainStringFromComponent))
    const back = tidyLines((bTag || []).map(toPlainStringFromComponent))
    return { front, back }
  }

  return { front: [], back: [] }
}

/**
 * Check if a word exactly matches any line in the given lines
 * @param lines The lines to check
 * @param word The word to match
 * @returns True if the word exactly matches any line, false otherwise
 */
export function exactWordMatch(lines: string[], word: string): boolean {
  const target = String(word)
  return lines
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => s === target)
}

/**
 * Get the forward direction vector of a sign block
 * @param block The sign block
 * @returns A Vec3 representing the forward direction
 */
export function getSignForward(block: any): Vec3 {
  const props = typeof block.getProperties === 'function' ? block.getProperties() : null
  const facing = props?.facing as string | undefined

  if (facing) {
    if (facing === 'north') return new Vec3(0, 0, -1)
    if (facing === 'south') return new Vec3(0, 0, 1)
    if (facing === 'west') return new Vec3(-1, 0, 0)
    if (facing === 'east') return new Vec3(1, 0, 0)
  }

  const rot = props?.rotation as number | undefined
  if (typeof rot === 'number') {
    const angle = (rot / 16) * 2 * Math.PI
    const dx = Math.round(Math.cos(angle))
    const dz = Math.round(Math.sin(angle))
    const v = new Vec3(dx || 0, 0, dz || 0)
    if (v.x === 0 && v.z === 0) {
      return Math.cos(angle) > 0 ? new Vec3(1, 0, 0) : new Vec3(-1, 0, 0)
    }
    return v
  }

  return new Vec3(0, 0, 1)
}
