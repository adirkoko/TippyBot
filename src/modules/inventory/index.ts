// src/modules/inventory/index.ts
// Inventory and equipment commands: inventory, equip, drop, give.
// None of these register with ctx.tasks -- they're single, near-instantaneous
// operations (like !where/!look), not long-running/cancelable ones.

import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import { reportError } from '../../utils/errors'
import { countItem, resolveItemName, summarizeInventory } from '../../utils/items'

/** Max distance (in blocks) the target player must be within before !give drops an item near them */
const GIVE_MAX_DISTANCE = 5

const inventoryModule: IModule = {
  id: 'inventory',
  description: 'Inventory and equipment: inventory, equip, drop, give',

  init(ctx) {
    const { commands, logger } = ctx

    const inventoryCommand: ICommand = {
      name: 'inventory',
      description: "Shows a summary of the bot's inventory",
      usage: '!inventory',
      requiredLevel: 'member',
      params: [],
      async execute({ ctx }) {
        try {
          const items = ctx.bot.inventory.items()
          ctx.bot.chat(`Inventory: ${summarizeInventory(items)}`)
        } catch (err) {
          reportError(ctx, 'inventory command', err)
        }
      }
    }

    commands.register(inventoryCommand)

    const equipCommand: ICommand = {
      name: 'equip',
      description: 'Equips a matching item to hand',
      usage: '!equip <item>',
      requiredLevel: 'member',
      params: [{ name: 'item', type: 'string' }],
      cooldown: { perPlayerMs: 1000 },
      async execute({ ctx, username, args }) {
        try {
          const resolution = resolveItemName(ctx.bot.registry, args[0])
          if (!resolution.ok) {
            ctx.bot.chat(resolution.message)
            return
          }

          const item = ctx.bot.inventory.items().find((i) => i.name === resolution.name)
          if (!item) {
            ctx.bot.chat(`I don't have any ${resolution.displayName}.`)
            return
          }

          await ctx.bot.equip(item, 'hand')
          logger.info(`equip (user=${username}, item=${resolution.name})`)
          ctx.bot.chat(`Equipped ${resolution.displayName}.`)
        } catch (err) {
          reportError(ctx, 'equip command', err)
        }
      }
    }

    commands.register(equipCommand)

    const dropCommand: ICommand = {
      name: 'drop',
      description: 'Drops a quantity of a matching item',
      usage: '!drop <item> [amount]',
      requiredLevel: 'member',
      params: [
        { name: 'item', type: 'string' },
        { name: 'amount', type: 'integer', optional: true, min: 1 }
      ],
      cooldown: { perPlayerMs: 1000 },
      async execute({ ctx, username, args }) {
        try {
          const resolution = resolveItemName(ctx.bot.registry, args[0])
          if (!resolution.ok) {
            ctx.bot.chat(resolution.message)
            return
          }

          const held = countItem(ctx.bot.inventory.items(), resolution.name)
          if (held === 0) {
            ctx.bot.chat(`I don't have any ${resolution.displayName}.`)
            return
          }

          const amount = args[1] !== undefined ? Number(args[1]) : held
          if (amount > held) {
            ctx.bot.chat(`I only have ${held} ${resolution.displayName}.`)
            return
          }

          await ctx.bot.toss(resolution.id, null, amount)
          logger.info(`drop (user=${username}, item=${resolution.name}, amount=${amount})`)
          ctx.bot.chat(`Dropped ${amount}x ${resolution.displayName}.`)
        } catch (err) {
          reportError(ctx, 'drop command', err)
        }
      }
    }

    commands.register(dropCommand)

    const giveCommand: ICommand = {
      name: 'give',
      description: 'Gives a quantity of a matching item to a nearby player',
      usage: '!give <player> <item> [amount]',
      requiredLevel: 'operator',
      params: [
        { name: 'player', type: 'playerName' },
        { name: 'item', type: 'string' },
        { name: 'amount', type: 'integer', optional: true, min: 1 }
      ],
      cooldown: { perPlayerMs: 1000 },
      async execute({ ctx, username, args }) {
        try {
          const targetName = args[0]
          const resolution = resolveItemName(ctx.bot.registry, args[1])
          if (!resolution.ok) {
            ctx.bot.chat(resolution.message)
            return
          }

          const player = ctx.bot.players[targetName]
          if (!player || !player.entity) {
            logger.info(`give target not visible: ${targetName}`)
            ctx.bot.chat("Can't see that player.")
            return
          }

          const distance = ctx.bot.entity.position.distanceTo(player.entity.position)
          if (distance > GIVE_MAX_DISTANCE) {
            logger.info(`give target too far: ${targetName} (distance=${Math.round(distance)})`)
            ctx.bot.chat(`${targetName} is too far away.`)
            return
          }

          const held = countItem(ctx.bot.inventory.items(), resolution.name)
          if (held === 0) {
            ctx.bot.chat(`I don't have any ${resolution.displayName}.`)
            return
          }

          const amount = args[2] !== undefined ? Number(args[2]) : held
          if (amount > held) {
            ctx.bot.chat(`I only have ${held} ${resolution.displayName}.`)
            return
          }

          await ctx.bot.toss(resolution.id, null, amount)
          logger.info(`give (user=${username}, target=${targetName}, item=${resolution.name}, amount=${amount})`)
          ctx.bot.chat(`Gave ${amount}x ${resolution.displayName} to ${targetName}.`)
        } catch (err) {
          reportError(ctx, 'give command', err)
        }
      }
    }

    commands.register(giveCommand)

    logger.info('inventory module initialized')
  }
}

export default inventoryModule
