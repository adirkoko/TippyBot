// src/modules/navigation/index.ts
// Basic navigation module providing come and jump actions/commands

import type { IModule } from '../../interfaces/module'
import type { IAction } from '../../interfaces/action'
import type { ICommand } from '../../interfaces/command'
import { Movements, goals } from 'mineflayer-pathfinder'
import { createChatThrottler, createCommandCooldownManager } from '../../utils/chat'
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
  id: number
  type: 'come'
  targetName: string
  startedAt: number
  timeoutHandle?: ReturnType<typeof setTimeout>
}

const navigationModule: IModule = {
  id: 'navigation',
  description: 'Basic navigation: come, jump',

  init(ctx) {
    const { bot, actions, commands, logger } = ctx

    // --- Shared state for this module ---
    let activeNav: ActiveNavigation | null = null
    let navCounter = 0

    const chatThrottled = createChatThrottler(bot)
    const checkCommandCooldown = createCommandCooldownManager()

    /**
     * Clears the active navigation state.
     * @param reason The reason for clearing the active navigation
     * @returns void
     */
    function clearActiveNav(reason: string) {
      if (!activeNav) return

      if (activeNav.timeoutHandle) {
        clearTimeout(activeNav.timeoutHandle)
      }

      logger.info(`navigation finished (reason=${reason}, target=${activeNav.targetName})`)

      activeNav = null
      ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
    }


    /**
     * Attaches a timeout to the current navigation.
     * @param currentNav The current active navigation state
     */
    function attachNavigationTimeout(currentNav: ActiveNavigation) {
      const id = currentNav.id

      const timeoutHandle = setTimeout(() => {
        if (!activeNav || activeNav.id !== id) return

        logger.info(`navigation timeout (target=${activeNav.targetName})`)
        bot.chat("Couldn't reach it in time.")

        bot.pathfinder.stop()
        clearActiveNav('navigation_timeout')
      }, NAVIGATION_TIMEOUT_MS)

      currentNav.timeoutHandle = timeoutHandle
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

    bot.on('death', () => {
      if (!activeNav) return
      logger.info(`bot died during navigation (target=${activeNav.targetName})`)
      bot.chat("Oops... I died.")

      clearActiveNav('death')
    })

    bot.on('end', () => {
      if (activeNav) {
        logger.error('bot disconnected during active navigation')
        activeNav = null
        ctx.pathfinderLock.release(NAVIGATION_OWNER_ID)
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

          if (activeNav) {
            if (activeNav.type === 'come') {
              if (activeNav.targetName === targetName) {
                logger.info(`navigation already active (target=${activeNav.targetName})`)
                ctx.bot.chat("I'm already on my way.")

              } else {
                logger.info(`navigation conflict (requested=${targetName}, active=${activeNav.targetName})`)
                ctx.bot.chat("I'm busy with another trip.")

              }
            } else {
              logger.info(`navigation already running (type=${activeNav.type})`)
              ctx.bot.chat("I'm on a task already.")

            }
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

          const movements = new Movements(ctx.bot)
          movements.allowParkour = false
          movements.allow1by1towers = false

          ctx.bot.pathfinder.setMovements(movements)
          ctx.bot.pathfinder.setGoal(
            new (goals as any).GoalNear(targetPos.x, targetPos.y, targetPos.z, 1)
          )

          const id = ++navCounter
          activeNav = {
            id,
            type: 'come',
            targetName,
            startedAt: Date.now()
          }

          attachNavigationTimeout(activeNav)

          logger.info(`navigation started (id=${id}, target=${targetName})`)
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
      async execute({ ctx, username }) {
        try {
          if (!checkCommandCooldown(username, COMMAND_COOLDOWN_MS)) return
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
      async execute({ ctx, username, args }) {
        try {
          if (!checkCommandCooldown(username, COMMAND_COOLDOWN_MS)) return

          const targetName = args[0] || username

          if (!targetName) {
            logger.info(`come command missing target (command-level)`)
            ctx.bot.chat("I need a name to go to.")
            return
          }


          await ctx.actions.run('come', ctx, [targetName])
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
