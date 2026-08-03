// src/interfaces/params.ts

export type ParamType = 'string' | 'playerName' | 'groupName' | 'integer' | 'enum'

export interface ParamSpec {
  /** Used in generated usage/error messages, e.g. 'player'. */
  name: string
  type: ParamType
  /** Defaults to false (required). */
  optional?: boolean
  /** For type: 'integer' */
  min?: number
  /** For type: 'integer' */
  max?: number
  /** For type: 'enum' -- allowed values, matched case-insensitively. */
  values?: string[]
  /** If true, this must be the last spec; consumes all remaining args as one value (e.g. a chat message) instead of counting them individually. */
  rest?: boolean
}

export type ParamValidationResult =
  | { ok: true }
  | { ok: false; message: string }
