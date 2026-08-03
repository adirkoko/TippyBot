// src/modules/gathering/index.ts
// Gathering commands: collect (pick up dropped items) and mine (break approved blocks).

import { Movements, goals } from 'mineflayer-pathfinder'
import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import type { IBotContext } from '../../interfaces/bot-context'
import { waitForGoalReached, nearestPosition } from '../../utils/navigation'
import { countItem, resolveItemName } from '../../utils/items'
import { resolveBlockName } from '../../utils/blocks'
import { reportError } from '../../utils/errors'

const GoalNear = (goals as any).GoalNear

const COMMAND_COOLDOWN_MS = 2000

// ---- !collect ----

/** Identifier used when this module "owns" the pathfinder for !collect */
const COLLECT_OWNER_ID = 'gathering:collect'

/** How far away (in blocks) the bot will search for dropped items */
const COLLECT_RADIUS = 16

/** Safety cap on how many separate drops a single !collect will walk to */
const MAX_COLLECT_TARGETS = 20

/** Timeout for walking to a single drop */
const COLLECT_STEP_TIMEOUT_MS = 10_000

/** Overall task timeout for the whole collection run */
const COLLECT_TASK_TIMEOUT_MS = 60_000

async function performCollect(
  ctx: IBotContext,
  itemQuery: string,
  amountArg: string | undefined,
  requestedBy: string
): Promise<void> {
  const { bot, logger } = ctx

  const resolution = resolveItemName(bot.registry, itemQuery)
  if (!resolution.ok) {
    bot.chat(resolution.message)
    return
  }

  const activeTask = ctx.tasks.getActive()
  if (activeTask) {
    logger.info(`collect blocked: task active (name=${activeTask.name})`)
    bot.chat("I'm busy with something else right now.")
    return
  }

  if (!bot.pathfinder) {
    logger.error('pathfinder missing')
    bot.chat("Can't move right now.")
    return
  }

  if (!ctx.pathfinderLock.acquire(COLLECT_OWNER_ID)) {
    logger.info(`collect blocked by owner=${ctx.pathfinderLock.getOwner()?.id}`)
    bot.chat('Someone else is steering me right now.')
    return
  }

  const startingHeld = countItem(bot.inventory.items(), resolution.name)
  const targetAmount = amountArg !== undefined ? Number(amountArg) : Infinity

  const task = ctx.tasks.start({
    name: 'collect',
    requestedBy,
    timeoutMs: COLLECT_TASK_TIMEOUT_MS,
    onEnd: (reason) => {
      if (reason === 'timeout') bot.chat("Couldn't finish collecting in time.")
      else if (reason === 'cancelled') bot.chat('Cancelled.')
      bot.pathfinder?.stop()
      ctx.pathfinderLock.release(COLLECT_OWNER_ID)
    }
  })

  if (!task) {
    logger.info('collect blocked: task slot taken concurrently')
    bot.chat("I'm busy with something else right now.")
    ctx.pathfinderLock.release(COLLECT_OWNER_ID)
    return
  }

  const movements = new Movements(bot)
  movements.allowParkour = false
  movements.allow1by1towers = false
  bot.pathfinder.setMovements(movements)

  try {
    for (let visited = 0; visited < MAX_COLLECT_TARGETS; visited++) {
      const collectedSoFar = countItem(bot.inventory.items(), resolution.name) - startingHeld
      if (collectedSoFar >= targetAmount) break

      const dropPositions = Object.values(bot.entities)
        .filter((entity) => entity.isValid !== false)
        .filter((entity) => {
          const dropped = entity.getDroppedItem()
          return dropped !== null && dropped.name === resolution.name
        })
        .map((entity) => entity.position)
        .filter((pos) => distanceTo(bot.entity.position, pos) <= COLLECT_RADIUS)

      const nearest = nearestPosition(dropPositions, bot.entity.position)
      if (!nearest) break

      bot.pathfinder.setGoal(new GoalNear(nearest.x, nearest.y, nearest.z, 1))
      await waitForGoalReached(ctx, COLLECT_STEP_TIMEOUT_MS, task.signal)

      // Give Minecraft's automatic pickup a moment to register before re-checking.
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  } catch (err) {
    if (!task.signal.aborted) {
      reportError(ctx, 'collect command', err, "Couldn't reach one of the items.")
    }
  } finally {
    ctx.pathfinderLock.release(COLLECT_OWNER_ID)
    task.finish()
  }

  const totalCollected = countItem(bot.inventory.items(), resolution.name) - startingHeld
  if (totalCollected > 0) {
    logger.info(`collect (user=${requestedBy}, item=${resolution.name}, amount=${totalCollected})`)
    bot.chat(`Collected ${totalCollected}x ${resolution.displayName}.`)
  } else {
    bot.chat(`Couldn't find any ${resolution.displayName} nearby.`)
  }
}

function distanceTo(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

// ---- !mine ----

/** Identifier used when this module "owns" the pathfinder for !mine */
const MINE_OWNER_ID = 'gathering:mine'

/** How far away (in blocks) the bot will search for a matching block */
const MINE_SEARCH_RADIUS = 16

/** Safety cap on how many blocks a single !mine will break */
const MAX_MINE_AMOUNT = 64

/** Safety cap on how many candidate blocks to visit (in case some turn out unreachable) */
const MAX_MINE_TARGETS = 30

/** Timeout for walking to a single block */
const MINE_STEP_TIMEOUT_MS = 15_000

/** Overall task timeout for the whole mining run */
const MINE_TASK_TIMEOUT_MS = 90_000

/** Stop mining if health drops this many points below where it was when !mine started */
const MINE_HEALTH_DROP_ABORT_THRESHOLD = 4

/**
 * Deliberately conservative first-pass allowlist: common terrain/building blocks and the
 * shallowest ores. No containers, redstone, protected/dangerous blocks (TNT, spawners,
 * portals), or anything below copper-tier ore. Expand later, deliberately, not by accident.
 */
const MINEABLE_BLOCKS = new Set([
  'dirt',
  'grass_block',
  'sand',
  'gravel',
  'clay',
  'stone',
  'cobblestone',
  'andesite',
  'diorite',
  'granite',
  'sandstone',
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'copper_ore',
  'deepslate_copper_ore'
])

async function performMine(
  ctx: IBotContext,
  blockQuery: string,
  amountArg: string | undefined,
  requestedBy: string
): Promise<void> {
  const { bot, logger } = ctx

  const resolution = resolveBlockName(bot.registry, blockQuery)
  if (!resolution.ok) {
    bot.chat(resolution.message)
    return
  }

  if (!MINEABLE_BLOCKS.has(resolution.name)) {
    bot.chat(`I'm not allowed to mine ${resolution.displayName}.`)
    return
  }

  const activeTask = ctx.tasks.getActive()
  if (activeTask) {
    logger.info(`mine blocked: task active (name=${activeTask.name})`)
    bot.chat("I'm busy with something else right now.")
    return
  }

  if (!bot.pathfinder) {
    logger.error('pathfinder missing')
    bot.chat("Can't move right now.")
    return
  }

  if (!ctx.pathfinderLock.acquire(MINE_OWNER_ID)) {
    logger.info(`mine blocked by owner=${ctx.pathfinderLock.getOwner()?.id}`)
    bot.chat('Someone else is steering me right now.')
    return
  }

  const targetAmount = Math.min(amountArg !== undefined ? Number(amountArg) : 1, MAX_MINE_AMOUNT)
  const startingHealth = bot.health
  let minedCount = 0

  const task = ctx.tasks.start({
    name: 'mine',
    requestedBy,
    timeoutMs: MINE_TASK_TIMEOUT_MS,
    onEnd: (reason) => {
      if (reason === 'timeout') bot.chat("Couldn't finish mining in time.")
      else if (reason === 'cancelled') bot.chat('Cancelled.')
      bot.pathfinder?.stop()
      bot.stopDigging()
      ctx.pathfinderLock.release(MINE_OWNER_ID)
    }
  })

  if (!task) {
    logger.info('mine blocked: task slot taken concurrently')
    bot.chat("I'm busy with something else right now.")
    ctx.pathfinderLock.release(MINE_OWNER_ID)
    return
  }

  const movements = new Movements(bot)
  movements.allowParkour = false
  movements.allow1by1towers = false
  bot.pathfinder.setMovements(movements)

  let stopReason: string | null = null

  try {
    for (let visited = 0; visited < MAX_MINE_TARGETS && minedCount < targetAmount; visited++) {
      if (bot.health <= startingHealth - MINE_HEALTH_DROP_ABORT_THRESHOLD) {
        stopReason = "I'm taking damage -- stopping."
        break
      }

      if (bot.inventory.emptySlotCount() === 0) {
        stopReason = 'My inventory is full.'
        break
      }

      const positions = bot.findBlocks({
        matching: (block) => !!block && block.name === resolution.name,
        maxDistance: MINE_SEARCH_RADIUS,
        count: 32
      })
      const targetPos = nearestPosition(positions, bot.entity.position)
      if (!targetPos) {
        if (visited === 0) stopReason = `No ${resolution.displayName} within ${MINE_SEARCH_RADIUS} blocks.`
        break
      }

      const block = bot.blockAt(targetPos)
      if (!block || block.name !== resolution.name) continue // vanished/changed since the search

      const tool = bot.pathfinder.bestHarvestTool(block)
      if (block.harvestTools && !tool) {
        stopReason = `I don't have a tool that can harvest ${resolution.displayName}.`
        break
      }
      if (tool) {
        await bot.equip(tool, 'hand')
      }

      bot.pathfinder.setGoal(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3))
      await waitForGoalReached(ctx, MINE_STEP_TIMEOUT_MS, task.signal)

      const freshBlock = bot.blockAt(targetPos)
      if (!freshBlock || freshBlock.name !== resolution.name) continue // gone by the time we arrived

      if (!bot.canDigBlock(freshBlock)) {
        stopReason = `Can't dig ${resolution.displayName} right now.`
        break
      }

      await bot.dig(freshBlock)
      minedCount++
    }
  } catch (err) {
    if (!task.signal.aborted) {
      reportError(ctx, 'mine command', err, 'Something went wrong while mining.')
    }
  } finally {
    ctx.pathfinderLock.release(MINE_OWNER_ID)
    task.finish()
  }

  if (stopReason) bot.chat(stopReason)

  if (minedCount > 0) {
    logger.info(`mine (user=${requestedBy}, block=${resolution.name}, amount=${minedCount})`)
    bot.chat(`Mined ${minedCount}x ${resolution.displayName}.`)
  } else if (!stopReason) {
    bot.chat(`Didn't mine any ${resolution.displayName}.`)
  }
}

const gatheringModule: IModule = {
  id: 'gathering',
  description: 'Gathering: collect, mine',

  init(ctx) {
    const { commands, logger } = ctx

    const collectCommand: ICommand = {
      name: 'collect',
      description: 'Picks up dropped items of a given type from the ground nearby',
      usage: '!collect <item> [amount]',
      requiredLevel: 'member',
      params: [
        { name: 'item', type: 'string' },
        { name: 'amount', type: 'integer', optional: true, min: 1 }
      ],
      cooldown: { perPlayerMs: COMMAND_COOLDOWN_MS },
      async execute({ ctx, username, args }) {
        try {
          await performCollect(ctx, args[0], args[1], username)
        } catch (err) {
          reportError(ctx, 'collect command', err)
        }
      }
    }

    commands.register(collectCommand)

    const mineCommand: ICommand = {
      name: 'mine',
      description: 'Mines a quantity of an approved block type',
      usage: '!mine <block> [amount]',
      requiredLevel: 'operator',
      params: [
        { name: 'block', type: 'string' },
        { name: 'amount', type: 'integer', optional: true, min: 1, max: 64 }
      ],
      cooldown: { perPlayerMs: COMMAND_COOLDOWN_MS },
      async execute({ ctx, username, args }) {
        try {
          await performMine(ctx, args[0], args[1], username)
        } catch (err) {
          reportError(ctx, 'mine command', err)
        }
      }
    }

    commands.register(mineCommand)

    logger.info('gathering module initialized')
  }
}

export default gatheringModule
