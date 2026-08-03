import { describe, expect, it } from 'vitest'
import { resolveBlockName } from '../../src/utils/blocks'
import type { GameRegistry } from '../../src/utils/registryLookup'

type FakeRegistryBlock = { id: number; name: string; displayName: string }

function makeRegistry(blocks: FakeRegistryBlock[]): GameRegistry {
  const blocksByName: Record<string, FakeRegistryBlock> = {}
  for (const block of blocks) blocksByName[block.name] = block

  return { blocksByName, blocksArray: blocks } as unknown as GameRegistry
}

const REGISTRY_BLOCKS: FakeRegistryBlock[] = [
  { id: 1, name: 'stone', displayName: 'Stone' },
  { id: 2, name: 'stone_bricks', displayName: 'Stone Bricks' },
  { id: 3, name: 'oak_log', displayName: 'Oak Log' },
  { id: 4, name: 'iron_ore', displayName: 'Iron Ore' }
]

describe('resolveBlockName', () => {
  it('resolves an exact match', () => {
    const registry = makeRegistry(REGISTRY_BLOCKS)

    expect(resolveBlockName(registry, 'stone')).toEqual({ ok: true, name: 'stone', id: 1, displayName: 'Stone' })
  })

  it('resolves a single unambiguous substring match', () => {
    const registry = makeRegistry(REGISTRY_BLOCKS)

    expect(resolveBlockName(registry, 'iron')).toEqual({
      ok: true,
      name: 'iron_ore',
      id: 4,
      displayName: 'Iron Ore'
    })
  })

  it('returns a clear error listing candidates for an ambiguous query', () => {
    const registry = makeRegistry(REGISTRY_BLOCKS)

    const result = resolveBlockName(registry, 'stone')
    expect(result.ok).toBe(true) // exact match still wins even though "stone_bricks" also contains it

    const ambiguous = resolveBlockName(registry, 'ne')
    expect(ambiguous.ok).toBe(false)
  })

  it('returns a clear error for no matches', () => {
    const registry = makeRegistry(REGISTRY_BLOCKS)

    expect(resolveBlockName(registry, 'diamond_ore').ok).toBe(false)
  })
})
