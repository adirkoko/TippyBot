// src/modules/navigation/index.ts
// Basic navigation module providing come and jump actions/commands

import type { IModule } from '../../interfaces/module'
import type { IAction } from '../../interfaces/action'
import type { ICommand } from '../../interfaces/command'
import type { TaskHandle, TaskEndReason } from '../../interfaces/tasks'
import { Movements, goals } from 'mineflayer-pathfinder'
import { createChatThrottler } from '../../utils/chat'
import { distanceSquared } from '../../utils/navigation'
import { reportError } from '../../utils/errors'
import { isValidPlayerName } from '../../utils/validation'

/** Maximum distance (in blocks) that the bot will agree to walk for !come */
const MAX_COME_DISTANCE = 256

/** Cooldown between commands from the same user (in ms) */
const COMMAND_COOLDOWN_MS = 2000

/** Global timeout for a single navigation attempt (in ms) */
const NAVIGATION_TIMEOUT_MS = 30_000

/** Identifier used when this module "owns" the pathfinder */
const NAVIGATION_OWNER_ID = 'navigation:come'

/** Internal type representing an active navigation state */
type ActiveNavigation = {
  targetName: string
  taskHandle: TaskHandle
}

const navigationModule: IModule = {
  id: 'navigation',
  description: 'Basic navigation: come, jump',

  init(ctx) {
    const { bot, actions, commands, logger } = ctx

    // --- Shared state for this module ---
    let activeNav: ActiveNavigation | null = null

    const chatThrottled = createChatThrottler(bot)

    /**
     * Clears the active navigation state (task slot + pathfinder lock).
     * @param reason The reason for clearing the active navigation
     */
    function clearActiveNav(reason: string) {
      if (!activeNav) return

      activeNav.taskHandle.finish()
      logger.info(`navigation finished (reason=${reason}, target=${activeNav.targetName})`)

      activeNav = null
      ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
    }

    /**
     * Reacts to the task ending abnormally (timeout, !cancel, death, or disconnect).
     * @param reason Why the task ended
     */
    function onTaskEnd(reason: TaskEndReason) {
      switch (reason) {
        case 'timeout':
          bot.chat("Couldn't reach it in time.")
          bot.pathfinder?.stop()
          break
        case 'cancelled':
          bot.chat('Navigation cancelled.')
          bot.pathfinder?.stop()
          break
        case 'death':
          bot.chat('Oops... I died.')
          break
        case 'disconnected':
          // Connection is gone; nothing to say.
          break
      }
      clearActiveNav(reason)
    }

    // --- Pathfinding-related event handlers ---

    bot.on('goal_reached', () => {
      if (!activeNav) return
      logger.info(`goal reached (target=${activeNav.targetName})`)
      bot.chat("I've arrived!")

      clearActiveNav('goal_reached')
    })

    bot.on('path_update', (result: any) => {
      if (!activeNav) return

      if (result && result.status === 'noPath') {
        logger.info(`no path found (target=${activeNav.targetName})`)
        bot.chat("Can't reach that spot.")

        clearActiveNav('no_path')
      }
    })

    bot.on('path_reset', (reason: string) => {
      if (!activeNav) return

      if (reason === 'stuck') {
        logger.info(`navigation stuck (target=${activeNav.targetName})`)
        bot.chat("Got stuck on the way.")

        clearActiveNav('stuck')
      } else {
        logger.info(`path_reset while navigating (reason=${reason})`)
      }
    })

    // --- Action: jump ---

    const jumpAction: IAction = {
      name: 'jump',
      description: 'Make the bot jump once',
      async run(ctx) {
        try {
          ctx.bot.setControlState('jump', true)
          await new Promise((resolve) => setTimeout(resolve, 300))
          ctx.bot.setControlState('jump', false)
        } catch (err) {
          logger.error(`jump action failed: ${String(err)}`)
          chatThrottled('jumpError', 'Something went wrong while trying to jump.')
        }
      }
    }

    actions.register(jumpAction)

    // --- Action: come ---

    const comeAction: IAction = {
      name: 'come',
      description: 'Walk near a player',
      async run(ctx, args) {
        try {
          const targetName = args[0]
          const requestedBy = args[1] ?? targetName

          if (!targetName) {
            logger.info(`come command missing target`)
            ctx.bot.chat("I need a name to go to.")
            return
          }

          if (!isValidPlayerName(targetName)) {
            logger.info(`invalid player name: ${targetName}`)
            ctx.bot.chat("That name doesn't look right.")

            return
          }

          const activeTask = ctx.tasks.getActive()
          if (activeTask) {
            logger.info(`navigation blocked: task active (name=${activeTask.name}, requestedBy=${activeTask.requestedBy})`)
            ctx.bot.chat("I'm busy with something else right now.")
            return
          }

          if (!ctx.bot.pathfinder) {
            logger.error(`pathfinder missing`)
            ctx.bot.chat("Can't move right now.")
            return
          }

          if (!ctx.pathfinderLock.acquire(NAVIGATION_OWNER_ID)) {
            logger.info(`navigation blocked by owner=${ctx.pathfinderLock.getOwner()?.id}`)
            ctx.bot.chat("Someone else is steering me right now.")

            return
          }

          const player = ctx.bot.players[targetName]
          if (!player) {
            logger.info(`player not found: ${targetName}`)
            ctx.bot.chat("Can't find that player.")

            ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
            return
          }

          if (!player.entity) {
            logger.info(`player entity missing: ${targetName}`)
            ctx.bot.chat("I can't see them right now.")

            ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
            return
          }

          const botPos = ctx.bot.entity.position
          const targetPos = player.entity.position
          const distanceSq = distanceSquared(targetPos, botPos)

          if (distanceSq > MAX_COME_DISTANCE * MAX_COME_DISTANCE) {
            const distance = Math.sqrt(distanceSq)
            logger.info(`target too far (target=${targetName}, distance=${Math.round(distance)})`)
            ctx.bot.chat("Too far for me.")

            ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
            return
          }

          const task = ctx.tasks.start({
            name: 'come',
            requestedBy,
            timeoutMs: NAVIGATION_TIMEOUT_MS,
            onEnd: onTaskEnd
          })

          if (!task) {
            logger.info('navigation blocked: task slot taken concurrently')
            ctx.bot.chat("I'm busy with something else right now.")
            ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
            return
          }

          const movements = new Movements(ctx.bot)
          movements.allowParkour = false
          movements.allow1by1towers = false

          ctx.bot.pathfinder.setMovements(movements)
          ctx.bot.pathfinder.setGoal(
            new (goals as any).GoalNear(targetPos.x, targetPos.y, targetPos.z, 1)
          )

          activeNav = { targetName, taskHandle: task }

          logger.info(`navigation started (id=${task.id}, target=${targetName})`)
          ctx.bot.chat("On my way!")

        } catch (err) {
          reportError(ctx, 'come action', err)
          clearActiveNav('error')
        }
      }
    }

    actions.register(comeAction)

    // --- Command: !jump ---

    const jumpCommand: ICommand = {
      name: 'jump',
      description: 'Make the bot jump once',
      usage: '!jump',
      requiredLevel: 'user',
      params: [],
      cooldown: { perPlayerMs: COMMAND_COOLDOWN_MS },
      async execute({ ctx }) {
        try {
          await ctx.actions.run('jump', ctx, [])
        } catch (err) {
          reportError(ctx, 'jump command', err)
        }
      }
    }

    commands.register(jumpCommand)

    // --- Command: !come [player] ---

    const comeCommand: ICommand = {
      name: 'come',
      description: 'Make the bot come to you or to a given player',
      usage: '!come [playerName]',
      requiredLevel: 'member',
      params: [{ name: 'playerName', type: 'playerName', optional: true }],
      cooldown: { perPlayerMs: COMMAND_COOLDOWN_MS },
      async execute({ ctx, username, args }) {
        try {
          const targetName = args[0] || username
          await ctx.actions.run('come', ctx, [targetName, username])
        } catch (err) {
          reportError(ctx, 'come command', err)
        }
      }
    }

    commands.register(comeCommand)

    logger.info('navigation module initialized')
  }
}

export default navigationModule
