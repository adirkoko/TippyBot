// src/modules/sign-trapdoor/index.ts
// Module that provides a command to find a sign with the caller's username and toggle its trapdoor

import { Movements, goals } from 'mineflayer-pathfinder'
import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import type { IBotContext } from '../../interfaces/bot-context'
import { getSignLinesFromWorldState } from '../../utils/signWorld'
import { waitForGoalReached, isWithinDistance } from '../../utils/navigation'
import { reportError } from '../../utils/errors'

const GoalNear = (goals as any).GoalNear

/** Identifier used when this module "owns" the pathfinder */
const SIGN_TRAPDOOR_OWNER_ID = 'sign-trapdoor:s'

/**
 * Triggers the trapdoor located directly beneath a sign containing the specified label.
 * @param ctx The bot context
 * @param label The label to search for on signs
 * @param whisperTo Optional username to send a private message to
 * @returns 
 */
async function triggerTrapdoorForLabel(
  ctx: IBotContext,
  label: string,
  whisperTo?: string
): Promise<void> {
  const { bot, logger } = ctx
  const query = label.toLowerCase()

  // Find signs within 48 blocks
  const positions = bot.findBlocks({
    matching: (block) => !!block && block.name.includes('sign'),
    maxDistance: 48,
    count: 128
  })

  let foundSign: any = null
  let foundTrapdoor: any = null

  for (const pos of positions) {
    const signBlock = bot.blockAt(pos)
    if (!signBlock) continue

    const lines = getSignLinesFromWorldState(signBlock) || { front: [], back: [] }
    const allText = [...lines.front, ...lines.back].join(' ').toLowerCase()

    if (!allText.includes(query)) continue

    // Check for trapdoor directly beneath
    const trapPos = signBlock.position.offset(0, -1, 0)
    const trapdoorBlock = bot.blockAt(trapPos)

    if (!trapdoorBlock || !trapdoorBlock.name.includes('trapdoor')) continue

    foundSign = signBlock
    foundTrapdoor = trapdoorBlock
    break
  }

  if (!foundSign) {
    logger.warn(`SignTrapdoor: No sign found for label="${label}".`)
    bot.chat(`No sign with your name.`)
    return
  }

  if (!foundTrapdoor) {
    logger.warn(`SignTrapdoor: Sign found for label="${label}", but no trapdoor beneath it. SignPos=${foundSign.position}`)
    bot.chat(`Your sign has no trapdoor under it.`)
    return
  }


  const pathfinder = bot.pathfinder
  if (!pathfinder) {
    logger.error(`SignTrapdoor: Pathfinder not loaded, cannot navigate.`)
    bot.chat(`Can't move right now.`)
    return
  }

  if (!ctx.pathfinderLock.acquire(SIGN_TRAPDOOR_OWNER_ID)) {
    logger.info(`SignTrapdoor: navigation blocked by owner=${ctx.pathfinderLock.getOwner()?.id}`)
    bot.chat(`Someone else is steering me right now.`)
    return
  }

  logger.info(`SignTrapdoor: Navigating to trapdoor at ${foundTrapdoor.position} (label="${label}").`)
  bot.chat(`On my way.`)

  // Set up movements and goal
  const movements = new Movements(bot)
  pathfinder.setMovements(movements)

  const { x, y, z } = foundTrapdoor.position
  pathfinder.setGoal(new GoalNear(x, y, z, 2))

  // Wait for arrival
  try {
    await waitForGoalReached(ctx, 15000)
  } catch (err) {
    reportError(ctx, `SignTrapdoor: reach trapdoor at ${foundTrapdoor.position}`, err, "Couldn't reach it.")
    return
  } finally {
    ctx.pathfinderLock.release(SIGN_TRAPDOOR_OWNER_ID)
  }

  // Check distance
  const botPos = bot.entity.position
  const trapPos = foundTrapdoor.position
  const distance = botPos.distanceTo(trapPos)
  if (!isWithinDistance(botPos, foundTrapdoor.position, 4.5)) {
    logger.warn(
      `SignTrapdoor: Bot too far to interact. ` +
      `Distance=${round(distance)} blocks. ` +
      `BotPos=(${round(botPos.x)}, ${round(botPos.y)}, ${round(botPos.z)}), ` +
      `TrapdoorPos=(${round(trapPos.x)}, ${round(trapPos.y)}, ${round(trapPos.z)}), ` +
      `MaxReach=4.5`
    )
    bot.chat(`Too far for that.`)
    return
  }

  // Activate the trapdoor twice
  bot.activateBlock(foundTrapdoor)
  await new Promise((resolve) => setTimeout(resolve, 500))
  bot.activateBlock(foundTrapdoor)

  // Notify success
  if (whisperTo) {
    //console.log(whisperTo)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    logger.info(`SignTrapdoor: Trapdoor toggled for user="${whisperTo}", label="${label}", position=${foundTrapdoor.position}.`)
    bot.chat(`/msg ${whisperTo} The trapdoor for "${label}" has been toggled.`)
  }
}

/**
 * Rounds a number to two decimal places.
 * @param n The number to round
 * @returns The rounded number
 */
function round(n: number) {
  return Number(n.toFixed(2))
}

/**
 * The sign-trapdoor module that provides the !s command.
 */
const signTrapdoorModule: IModule = {
  id: 'sign-trapdoor',
  description: 'Find a sign with the caller username and toggle its trapdoor',

  init(ctx) {
    const { commands, logger } = ctx

    const sCommand: ICommand = {
      name: 's',
      description:
        'Search a sign containing the username of the caller, toggle its trapdoor twice, and send a private message',
      usage: '!s',
      async execute({ ctx, username }) {
        const label = username
        if (!label) {
          logger.warn(`SignTrapdoor: !s command executed without a valid username (console or system call).`)
          ctx.bot.chat(`Only players can use this.`)
          return
        }

        await triggerTrapdoorForLabel(ctx, label, username).catch((err) => {
          reportError(ctx, `SignTrapdoor: !s command for username="${username}"`, err)
        })
      }
    }

    commands.register(sCommand)

    logger.info('sign-trapdoor module initialized (only !s)')
  }
}

export default signTrapdoorModule
