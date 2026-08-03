// src/modules/access/index.ts
// The !access command tree: the player-facing surface of the permission system.
// All authorization decisions are delegated to ctx.permissions (PermissionService);
// this module only parses chat args and turns results into chat replies.

import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import type { IBotContext } from '../../interfaces/bot-context'
import { isValidPlayerName } from '../../utils/validation'
import { reportError } from '../../utils/errors'
import { capitalize } from '../../utils/text'

function parseGrantLevel(raw: string | undefined): 'operator' | 'member' | null {
  const lower = raw?.toLowerCase()
  if (lower === 'operator' || lower === 'member') return lower
  return null
}

async function handleMe(ctx: IBotContext, username: string): Promise<void> {
  const level = ctx.permissions.getLevel(username)
  const groups = ctx.permissions
    .listGroups()
    .filter((g) => g.members.includes(username.toLowerCase()))
    .map((g) => g.name)

  const groupsText = groups.length ? ` Groups: ${groups.join(', ')}.` : ''
  ctx.bot.chat(`You are: ${capitalize(level)}.${groupsText}`)
}

async function handlePlayer(ctx: IBotContext, target: string | undefined): Promise<void> {
  if (!target || !isValidPlayerName(target)) {
    ctx.bot.chat("That name doesn't look right.")
    return
  }
  const level = ctx.permissions.getLevel(target)
  ctx.bot.chat(`${target} is: ${capitalize(level)}.`)
}

async function handleGrantRevoke(
  ctx: IBotContext,
  actor: string,
  isGrant: boolean,
  target: string | undefined,
  levelArg: string | undefined
): Promise<void> {
  const level = parseGrantLevel(levelArg)
  if (!target || !level) {
    ctx.bot.chat('Usage: !access grant|revoke <player> operator|member')
    return
  }

  const result =
    level === 'operator'
      ? isGrant
        ? await ctx.permissions.grantOperator(actor, target)
        : await ctx.permissions.revokeOperator(actor, target)
      : isGrant
        ? await ctx.permissions.addMember(actor, target)
        : await ctx.permissions.removeMember(actor, target)

  ctx.bot.chat(result.message)
}

async function handleBlacklist(ctx: IBotContext, actor: string, args: string[]): Promise<void> {
  const [action, target] = args

  if (action?.toLowerCase() === 'list') {
    const list = ctx.permissions.listBlacklist()
    ctx.bot.chat(list.length ? `Blacklist: ${list.join(', ')}` : 'Blacklist is empty.')
    return
  }

  if ((action?.toLowerCase() === 'add' || action?.toLowerCase() === 'remove') && target) {
    const result =
      action.toLowerCase() === 'add'
        ? await ctx.permissions.addToBlacklist(actor, target)
        : await ctx.permissions.removeFromBlacklist(actor, target)
    ctx.bot.chat(result.message)
    return
  }

  ctx.bot.chat('Usage: !access blacklist add|remove <player> | !access blacklist list')
}

async function handleGroup(ctx: IBotContext, actor: string, args: string[]): Promise<void> {
  const [action, ...rest] = args

  switch (action?.toLowerCase()) {
    case 'create': {
      const [name] = rest
      if (!name) {
        ctx.bot.chat('Usage: !access group create <group>')
        return
      }
      const result = await ctx.permissions.createGroup(actor, name)
      ctx.bot.chat(result.message)
      return
    }

    case 'delete': {
      const [name] = rest
      if (!name) {
        ctx.bot.chat('Usage: !access group delete <group>')
        return
      }
      const result = await ctx.permissions.deleteGroup(actor, name)
      ctx.bot.chat(result.message)
      return
    }

    case 'rename': {
      const [oldName, newName] = rest
      if (!oldName || !newName) {
        ctx.bot.chat('Usage: !access group rename <oldName> <newName>')
        return
      }
      const result = await ctx.permissions.renameGroup(actor, oldName, newName)
      ctx.bot.chat(result.message)
      return
    }

    case 'list': {
      const groups = ctx.permissions.listGroups()
      ctx.bot.chat(groups.length ? `Groups: ${groups.map((g) => g.name).join(', ')}` : 'No groups.')
      return
    }

    case 'show': {
      const [name] = rest
      if (!name) {
        ctx.bot.chat('Usage: !access group show <group>')
        return
      }
      const group = ctx.permissions.getGroup(name)
      if (!group) {
        ctx.bot.chat(`Group "${name}" does not exist.`)
        return
      }
      const members = group.members.length ? group.members.join(', ') : 'none'
      const cmds = group.commands.length ? group.commands.join(', ') : 'none'
      ctx.bot.chat(`"${group.name}" - members: ${members}; commands: ${cmds}`)
      return
    }

    case 'member': {
      const [op, group, player] = rest
      if (!op || !group || !player) {
        ctx.bot.chat('Usage: !access group member add|remove <group> <player>')
        return
      }
      const result =
        op.toLowerCase() === 'add'
          ? await ctx.permissions.addGroupMember(actor, group, player)
          : op.toLowerCase() === 'remove'
            ? await ctx.permissions.removeGroupMember(actor, group, player)
            : null
      ctx.bot.chat(result ? result.message : 'Usage: !access group member add|remove <group> <player>')
      return
    }

    case 'command': {
      const [op, group, commandName] = rest
      if (!op || !group || !commandName) {
        ctx.bot.chat('Usage: !access group command add|remove <group> <command>')
        return
      }
      const result =
        op.toLowerCase() === 'add'
          ? await ctx.permissions.addGroupCommand(actor, group, commandName, ctx.commands)
          : op.toLowerCase() === 'remove'
            ? await ctx.permissions.removeGroupCommand(actor, group, commandName)
            : null
      ctx.bot.chat(result ? result.message : 'Usage: !access group command add|remove <group> <command>')
      return
    }

    default:
      ctx.bot.chat('Usage: !access group create|delete|rename|list|show|member|command ...')
  }
}

const accessModule: IModule = {
  id: 'access',
  description: 'Central permission management: levels, blacklist, and access groups',

  init(ctx) {
    const { commands, logger } = ctx

    const accessCommand: ICommand = {
      name: 'access',
      description: 'View and manage TippyBot permissions',
      usage: '!access <me|player|grant|revoke|blacklist|group> ...',
      requiredLevel: 'user',
      async execute({ ctx, username, args }) {
        try {
          const [sub, ...rest] = args

          switch (sub?.toLowerCase()) {
            case 'me':
              await handleMe(ctx, username)
              return
            case 'player':
              await handlePlayer(ctx, rest[0])
              return
            case 'grant':
              await handleGrantRevoke(ctx, username, true, rest[0], rest[1])
              return
            case 'revoke':
              await handleGrantRevoke(ctx, username, false, rest[0], rest[1])
              return
            case 'blacklist':
              await handleBlacklist(ctx, username, rest)
              return
            case 'group':
              await handleGroup(ctx, username, rest)
              return
            default:
              ctx.bot.chat('Usage: !access me|player|grant|revoke|blacklist|group ...')
          }
        } catch (err) {
          reportError(ctx, 'access command', err)
        }
      }
    }

    commands.register(accessCommand)
    logger.info('access module initialized')
  }
}

export default accessModule
