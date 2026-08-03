// src/modules/chests/index.ts
// Chest storage commands: deposit and withdraw, via the nearest reachable chest.

import { Movements, goals } from 'mineflayer-pathfinder'
import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import type { IBotContext } from '../../interfaces/bot-context'
import { waitForGoalReached, isWithinDistance, nearestPosition } from '../../utils/navigation'
import { countItem, resolveItemName } from '../../utils/items'
import { reportError } from '../../utils/errors'

const GoalNear = (goals as any).GoalNear

/** Identifier used when this module "owns" the pathfinder */
const CHEST_OWNER_ID = 'chests'

/** How far away (in blocks) the bot will search for a chest */
const CHEST_SEARCH_RADIUS = 16

/** Minecraft's interaction reach */
const CHEST_REACH = 4.5

/** Overall task timeout: walk + open + transfer */
const CHEST_TASK_TIMEOUT_MS = 30_000

const COMMAND_COOLDOWN_MS = 2000

type ChestOperation = 'deposit' | 'withdraw'

function findNearestChestBlock(ctx: IBotContext) {
  const { bot } = ctx
  const positions = bot.findBlocks({
    matching: (block) => !!block && (block.name === 'chest' || block.name === 'trapped_chest'),
    maxDistance: CHEST_SEARCH_RADIUS,
    count: 64
  })

  return nearestPosition(positions, bot.entity.position)
}

async function performChestOperation(
  ctx: IBotContext,
  operation: ChestOperation,
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

  if (operation === 'deposit' && countItem(bot.inventory.items(), resolution.name) === 0) {
    bot.chat(`I don't have any ${resolution.displayName}.`)
    return
  }

  const chestPos = findNearestChestBlock(ctx)
  if (!chestPos) {
    bot.chat(`No chest within ${CHEST_SEARCH_RADIUS} blocks.`)
    return
  }

  const activeTask = ctx.tasks.getActive()
  if (activeTask) {
    logger.info(`chest ${operation} blocked: task active (name=${activeTask.name})`)
    bot.chat("I'm busy with something else right now.")
    return
  }

  if (!bot.pathfinder) {
    logger.error('pathfinder missing')
    bot.chat("Can't move right now.")
    return
  }

  if (!ctx.pathfinderLock.acquire(CHEST_OWNER_ID)) {
    logger.info(`chest ${operation} blocked by owner=${ctx.pathfinderLock.getOwner()?.id}`)
    bot.chat('Someone else is steering me right now.')
    return
  }

  let openChest: Awaited<ReturnType<typeof bot.openChest>> | null = null

  const task = ctx.tasks.start({
    name: operation,
    requestedBy,
    timeoutMs: CHEST_TASK_TIMEOUT_MS,
    onEnd: (reason) => {
      if (reason === 'timeout') bot.chat("Couldn't get that done in time.")
      else if (reason === 'cancelled') bot.chat('Cancelled.')
      bot.pathfinder?.stop()
      openChest?.close()
      openChest = null
      ctx.pathfinderLock.release(CHEST_OWNER_ID)
    }
  })

  if (!task) {
    logger.info(`chest ${operation} blocked: task slot taken concurrently`)
    bot.chat("I'm busy with something else right now.")
    ctx.pathfinderLock.release(CHEST_OWNER_ID)
    return
  }

  try {
    const movements = new Movements(bot)
    movements.allowParkour = false
    movements.allow1by1towers = false
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.setGoal(new GoalNear(chestPos.x, chestPos.y, chestPos.z, 2))

    bot.chat('On my way to the chest.')

    await waitForGoalReached(ctx, 15000, task.signal)

    if (!isWithinDistance(bot.entity.position, chestPos, CHEST_REACH)) {
      bot.chat('Too far from the chest.')
      return
    }

    const chestBlock = bot.blockAt(chestPos)
    if (!chestBlock) {
      bot.chat("Can't find the chest anymore.")
      return
    }

    openChest = await bot.openChest(chestBlock)

    if (operation === 'deposit') {
      const held = countItem(bot.inventory.items(), resolution.name)
      if (held === 0) {
        bot.chat(`I don't have any ${resolution.displayName} anymore.`)
        return
      }
      const amount = amountArg !== undefined ? Number(amountArg) : held
      if (amount > held) {
        bot.chat(`I only have ${held} ${resolution.displayName}.`)
        return
      }

      await openChest.deposit(resolution.id, null, amount)
      logger.info(`chest deposit (user=${requestedBy}, item=${resolution.name}, amount=${amount})`)
      bot.chat(`Deposited ${amount}x ${resolution.displayName}.`)
    } else {
      const available = countItem(openChest.items(), resolution.name)
      if (available === 0) {
        bot.chat(`There's no ${resolution.displayName} in that chest.`)
        return
      }
      const amount = amountArg !== undefined ? Number(amountArg) : available
      if (amount > available) {
        bot.chat(`The chest only has ${available} ${resolution.displayName}.`)
        return
      }

      await openChest.withdraw(resolution.id, null, amount)
      logger.info(`chest withdraw (user=${requestedBy}, item=${resolution.name}, amount=${amount})`)
      bot.chat(`Withdrew ${amount}x ${resolution.displayName}.`)
    }
  } catch (err) {
    if (!task.signal.aborted) {
      reportError(ctx, `chest ${operation}`, err, "Couldn't reach the chest.")
    }
  } finally {
    openChest?.close()
    openChest = null
    ctx.pathfinderLock.release(CHEST_OWNER_ID)
    task.finish()
  }
}

const chestsModule: IModule = {
  id: 'chests',
  description: 'Chest storage: deposit, withdraw',

  init(ctx) {
    const { commands, logger } = ctx

    const depositCommand: ICommand = {
      name: 'deposit',
      description: 'Deposits items into the nearest reachable chest',
      usage: '!deposit <item> [amount]',
      requiredLevel: 'member',
      params: [
        { name: 'item', type: 'string' },
        { name: 'amount', type: 'integer', optional: true, min: 1 }
      ],
      cooldown: { perPlayerMs: COMMAND_COOLDOWN_MS },
      async execute({ ctx, username, args }) {
        try {
          await performChestOperation(ctx, 'deposit', args[0], args[1], username)
        } catch (err) {
          reportError(ctx, 'deposit command', err)
        }
      }
    }

    commands.register(depositCommand)

    const withdrawCommand: ICommand = {
      name: 'withdraw',
      description: 'Withdraws items from the nearest reachable chest',
      usage: '!withdraw <item> [amount]',
      requiredLevel: 'member',
      params: [
        { name: 'item', type: 'string' },
        { name: 'amount', type: 'integer', optional: true, min: 1 }
      ],
      cooldown: { perPlayerMs: COMMAND_COOLDOWN_MS },
      async execute({ ctx, username, args }) {
        try {
          await performChestOperation(ctx, 'withdraw', args[0], args[1], username)
        } catch (err) {
          reportError(ctx, 'withdraw command', err)
        }
      }
    }

    commands.register(withdrawCommand)

    logger.info('chests module initialized')
  }
}

export default chestsModule
