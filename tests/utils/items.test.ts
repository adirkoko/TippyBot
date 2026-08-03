import { describe, expect, it } from 'vitest'
import { countItem, resolveItemName, summarizeInventory, type ItemRegistry } from '../../src/utils/items'
import type { Item } from 'prismarine-item'

type FakeRegistryItem = { id: number; name: string; displayName: string }

function makeRegistry(items: FakeRegistryItem[]): ItemRegistry {
  const itemsByName: Record<string, FakeRegistryItem> = {}
  for (const item of items) itemsByName[item.name] = item

  return {
    itemsByName,
    itemsArray: items
  } as unknown as ItemRegistry
}

function makeItem(name: string, count: number): Item {
  return { name, count, type: 0, displayName: name, slot: 0 } as unknown as Item
}

const REGISTRY_ITEMS: FakeRegistryItem[] = [
  { id: 1, name: 'oak_log', displayName: 'Oak Log' },
  { id: 2, name: 'oak_planks', displayName: 'Oak Planks' },
  { id: 3, name: 'stone', displayName: 'Stone' },
  { id: 4, name: 'iron_pickaxe', displayName: 'Iron Pickaxe' }
]

describe('resolveItemName', () => {
  it('resolves an exact match', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    const result = resolveItemName(registry, 'stone')

    expect(result).toEqual({ ok: true, name: 'stone', id: 3, displayName: 'Stone' })
  })

  it('prefers an exact match over a broader substring match', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    // "oak_log" is both an exact match and a substring-prefix of nothing else here,
    // but this still exercises the "exact wins immediately" path.
    const result = resolveItemName(registry, 'oak_log')

    expect(result).toEqual({ ok: true, name: 'oak_log', id: 1, displayName: 'Oak Log' })
  })

  it('resolves a single unambiguous substring match', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    const result = resolveItemName(registry, 'pickaxe')

    expect(result).toEqual({ ok: true, name: 'iron_pickaxe', id: 4, displayName: 'Iron Pickaxe' })
  })

  it('is case-insensitive', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    const result = resolveItemName(registry, 'STONE')

    expect(result.ok).toBe(true)
  })

  it('returns a clear error for no matches, without guessing', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    const result = resolveItemName(registry, 'diamond_sword')

    expect(result.ok).toBe(false)
  })

  it('returns a clear error listing candidates for an ambiguous query, without picking one', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    const result = resolveItemName(registry, 'oak')

    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('oak_log')
    expect(!result.ok && result.message).toContain('oak_planks')
  })

  it('rejects an empty query', () => {
    const registry = makeRegistry(REGISTRY_ITEMS)

    expect(resolveItemName(registry, '   ').ok).toBe(false)
  })
})

describe('countItem', () => {
  it('sums counts across multiple stacks of the same item', () => {
    const items = [makeItem('oak_log', 32), makeItem('stone', 10), makeItem('oak_log', 5)]

    expect(countItem(items, 'oak_log')).toBe(37)
  })

  it('returns 0 when the item is not held', () => {
    expect(countItem([makeItem('stone', 10)], 'oak_log')).toBe(0)
  })
})

describe('summarizeInventory', () => {
  it('reports an empty inventory', () => {
    expect(summarizeInventory([])).toBe('empty')
  })

  it('groups and sums stacks of the same item', () => {
    const items = [makeItem('oak_log', 32), makeItem('oak_log', 5), makeItem('stone', 10)]

    expect(summarizeInventory(items)).toBe('oak_log x37, stone x10')
  })

  it('caps the number of distinct entries shown', () => {
    const items = Array.from({ length: 15 }, (_, i) => makeItem(`item_${i}`, 1))

    const summary = summarizeInventory(items)

    expect(summary).toContain('and 5 more')
  })
})
