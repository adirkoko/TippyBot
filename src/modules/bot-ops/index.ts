// src/modules/bot-ops/index.ts
// Basic operational utility commands: where, look, say

import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import { reportError } from '../../utils/errors'
import { formatDimension } from '../../utils/dimension'

/** Minecraft's own chat message length limit; enforced here so a bad !say fails fast with a clear reason. */
const MAX_SAY_LENGTH = 256

/** Control characters (incl. newlines/tabs) have no place in a single-line chat message. */
const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/

const botOpsModule: IModule = {
  id: 'bot-ops',
  description: 'Basic operational commands: where, look, say',

  init(ctx) {
    const { commands, logger } = ctx

    const whereCommand: ICommand = {
      name: 'where',
      description: "Shows the bot's current position and dimension",
      usage: '!where',
      requiredLevel: 'user',
      params: [],
      async execute({ ctx }) {
        try {
          const pos = ctx.bot.entity.position
          const dimension = formatDimension(ctx.bot.game.dimension)
          ctx.bot.chat(
            `I'm at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}) in the ${dimension}.`
          )
        } catch (err) {
          reportError(ctx, 'where command', err)
        }
      }
    }

    commands.register(whereCommand)

    const lookCommand: ICommand = {
      name: 'look',
      description: 'Makes the bot look at a player',
      usage: '!look <player>',
      requiredLevel: 'member',
      params: [{ name: 'player', type: 'playerName' }],
      cooldown: { perPlayerMs: 1000 },
      async execute({ ctx, args }) {
        try {
          const targetName = args[0]
          const player = ctx.bot.players[targetName]

          if (!player || !player.entity) {
            logger.info(`look target not visible: ${targetName}`)
            ctx.bot.chat("Can't see that player.")
            return
          }

          const eyeHeight = player.entity.height ?? 1.6
          const target = player.entity.position.offset(0, eyeHeight, 0)
          await ctx.bot.lookAt(target, true)
          ctx.bot.chat(`Looking at ${targetName}.`)
        } catch (err) {
          reportError(ctx, 'look command', err)
        }
      }
    }

    commands.register(lookCommand)

    const sayCommand: ICommand = {
      name: 'say',
      description: 'Makes the bot send a chat message',
      usage: '!say <message>',
      requiredLevel: 'operator',
      params: [{ name: 'message', type: 'string', rest: true }],
      cooldown: { globalMs: 1000 },
      async execute({ ctx, args }) {
        try {
          const message = args.join(' ').trim()

          if (!message) {
            ctx.bot.chat('Say what?')
            return
          }
          if (message.length > MAX_SAY_LENGTH) {
            ctx.bot.chat(`That message is too long (max ${MAX_SAY_LENGTH} characters).`)
            return
          }
          if (CONTROL_CHAR_REGEX.test(message)) {
            ctx.bot.chat("That message contains characters I can't send.")
            return
          }
          if (message.startsWith('/')) {
            ctx.bot.chat("I won't send messages that start with a slash.")
            return
          }

          ctx.bot.chat(message)
        } catch (err) {
          reportError(ctx, 'say command', err)
        }
      }
    }

    commands.register(sayCommand)

    logger.info('bot-ops module initialized')
  }
}

export default botOpsModule
