// src/core/param-validator.ts
import type { ICommand } from '../interfaces/command'
import type { ParamSpec, ParamValidationResult } from '../interfaces/params'
import { isValidGroupName, isValidPlayerName } from '../utils/validation'

/**
 * Validates chat args against a command's declared `params`, before execute()
 * is ever called. Commands that don't declare `params` are left untouched --
 * they're responsible for parsing their own (often variable-shaped) args.
 */
export function validateParams(command: ICommand, args: string[]): ParamValidationResult {
  const specs = command.params
  if (!specs) return { ok: true }

  const requiredCount = specs.filter((spec) => !spec.optional).length

  if (args.length < requiredCount) {
    return { ok: false, message: usageMessage(command) }
  }
  if (args.length > specs.length) {
    return { ok: false, message: `Too many arguments. ${usageMessage(command)}` }
  }

  for (let i = 0; i < args.length; i++) {
    const error = validateOne(specs[i], args[i])
    if (error) return { ok: false, message: error }
  }

  return { ok: true }
}

function validateOne(spec: ParamSpec, value: string): string | null {
  switch (spec.type) {
    case 'playerName':
      return isValidPlayerName(value) ? null : `"${value}" doesn't look like a valid player name.`

    case 'groupName':
      return isValidGroupName(value) ? null : `"${value}" doesn't look like a valid group name.`

    case 'integer': {
      const n = Number(value)
      if (!Number.isInteger(n)) return `"${spec.name}" must be a whole number.`
      if (spec.min !== undefined && n < spec.min) return `"${spec.name}" must be at least ${spec.min}.`
      if (spec.max !== undefined && n > spec.max) return `"${spec.name}" must be at most ${spec.max}.`
      return null
    }

    case 'enum': {
      const allowed = spec.values ?? []
      const matches = allowed.some((v) => v.toLowerCase() === value.toLowerCase())
      return matches ? null : `"${spec.name}" must be one of: ${allowed.join(', ')}.`
    }

    case 'string':
    default:
      return null
  }
}

function usageMessage(command: ICommand): string {
  return command.usage ? `Usage: ${command.usage}` : 'Invalid arguments.'
}
