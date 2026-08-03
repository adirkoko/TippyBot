import { createHash, timingSafeEqual } from 'crypto'

/** Compares passwords in constant time after normalizing both to fixed-size digests. */
export function verifyPassword(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(candidateDigest, expectedDigest)
}
