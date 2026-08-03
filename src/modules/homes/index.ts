// src/modules/homes/index.ts
// Per-player home locations: !sethome saves the caller's current spot, !home walks back to it.
// Reuses the navigation module's 'goto' action for the actual walk.

import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import { reportError } from '../../utils/errors'
import { formatDimension } from '../../utils/dimension'

const homesModule: IModule = {
  id: 'homes',
  description: 'Per-player home locations: sethome, home',

  init(ctx) {
    const { commands, logger } = ctx

    const sethomeCommand: ICommand = {
      name: 'sethome',
      description: "Saves the caller's current position as their home",
      usage: '!sethome',
      requiredLevel: 'member',
      params: [],
      async execute({ ctx, username }) {
        try {
          const pos = ctx.bot.entity.position
          const dimension = ctx.bot.game.dimension
          const location = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension }

          await ctx.homes.setHome(username, location)

          logger.info(`home set (user=${username}, x=${location.x}, y=${location.y}, z=${location.z}, dimension=${dimension})`)
          ctx.bot.chat(
            `Home set at (${location.x}, ${location.y}, ${location.z}) in the ${formatDimension(dimension)}.`
          )
        } catch (err) {
          reportError(ctx, 'sethome command', err)
        }
      }
    }

    commands.register(sethomeCommand)

    const homeCommand: ICommand = {
      name: 'home',
      description: "Walks to the caller's saved home",
      usage: '!home',
      requiredLevel: 'member',
      params: [],
      async execute({ ctx, username }) {
        try {
          const home = ctx.homes.getHome(username)
          if (!home) {
            ctx.bot.chat("You don't have a home set. Use !sethome first.")
            return
          }

          const currentDimension = ctx.bot.game.dimension
          if (home.dimension !== currentDimension) {
            ctx.bot.chat(
              `Your home is in the ${formatDimension(home.dimension)}, but I'm in the ${formatDimension(currentDimension)}. I can't cross dimensions.`
            )
            return
          }

          await ctx.actions.run('goto', ctx, [String(home.x), String(home.y), String(home.z), username])
        } catch (err) {
          reportError(ctx, 'home command', err)
        }
      }
    }

    commands.register(homeCommand)

    logger.info('homes module initialized')
  }
}

export default homesModule
