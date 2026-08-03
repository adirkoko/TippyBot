// src/modules/chat-basic/index.ts
import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import type { IAction } from '../../interfaces/action'

const chatBasicModule: IModule = {
  id: 'chat-basic',
  description: 'Basic chat commands like ping and tippy',

  init(ctx) {
    const { bot, commands, actions } = ctx

    // --- Action: say ---
    const sayAction: IAction = {
      name: 'say',
      description: 'Say a message in chat',
      async run(ctx, args) {
        const msg = args.join(' ')
        if (!msg) return
        ctx.bot.chat(msg)
      }
    }

    actions.register(sayAction)

    // --- Command: ping ---
    const pingCommand: ICommand = {
      name: 'ping',
      description: 'Simple ping command to test the bot',
      usage: '!ping',
      requiredLevel: 'user',
      params: [],
      async execute({ ctx, username }) {
        ctx.bot.chat(`Pong, ${username}!`)
      }
    }

    commands.register(pingCommand)

    // --- Command: tippy ---
    const tippyCommand: ICommand = {
      name: 'tippy',
      description: 'Your classic TippyBot reply',
      usage: '!tippy',
      requiredLevel: 'user',
      params: [],
      async execute({ ctx, username }) {
        ctx.bot.chat(`${username}, Don't even ask...`)
      }
    }

    commands.register(tippyCommand)

    // Log module initialization
    ctx.logger.info('chat-basic module initialized')
  }
}

export default chatBasicModule
