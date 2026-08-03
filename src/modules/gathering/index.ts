// src/modules/gathering/index.ts
// Gathering commands. Currently just !collect (picking up dropped items);
// !mine will join this module later.

import { Movements, goals } from 'mineflayer-pathfinder'
import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import type { IBotContext } from '../../interfaces/bot-context'
import { waitForGoalReached, nearestPosition } from '../../utils/navigation'
import { countItem, resolveItemName } from '../../utils/items'
import { reportError } from '../../utils/errors'

const GoalNear = (goals as any).GoalNear

/** Identifier used when this module "owns" the pathfinder */
const COLLECT_OWNER_ID = 'gathering:collect'

/** How far away (in blocks) the bot will search for dropped items */
const COLLECT_RADIUS = 16

/** Safety cap on how many separate drops a single !collect will walk to */
const MAX_COLLECT_TARGETS = 20

/** Timeout for walking to a single drop */
const COLLECT_STEP_TIMEOUT_MS = 10_000

/** Overall task timeout for the whole collection run */
const COLLECT_TASK_TIMEOUT_MS = 60_000

const COMMAND_COOLDOWN_MS = 2000

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

const gatheringModule: IModule = {
  id: 'gathering',
  description: 'Gathering: collect',

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

    logger.info('gathering module initialized')
  }
}

export default gatheringModule
