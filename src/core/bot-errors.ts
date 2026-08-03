// src/core/bot-errors.ts
// Typed errors for bot-instance lifecycle/CRUD failures. Kept separate from
// HTTP concerns -- src/web/routes/bots.ts maps these to status codes by
// `instanceof`, so core code never depends on the web layer's HttpError.

export class BotInstanceNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot instance "${id}" does not exist.`)
    this.name = 'BotInstanceNotFoundError'
  }
}

/** An operation that's invalid given the instance's current state or identity (duplicate id, already connecting, not connected, id change, ...). */
export class BotInstanceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BotInstanceConflictError'
  }
}
