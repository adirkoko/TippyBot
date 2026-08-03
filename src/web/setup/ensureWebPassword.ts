import { randomBytes } from 'crypto'
import { ensureEnvVariableAtomic } from '../../config/envFile'

export interface EnsureWebPasswordOptions {
  env?: NodeJS.ProcessEnv
  envPath?: string
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  randomBytes?: (size: number) => Buffer
}

/**
 * Ensures WEB_PASSWORD is available for this process and persists a generated
 * password when necessary. The secret is never printed; only a generic notice
 * is written directly to stdout, entirely outside the logging infrastructure.
 */
export async function ensureWebPassword(options: EnsureWebPasswordOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const configured = env.WEB_PASSWORD
  if (configured !== undefined) {
    if (configured.length === 0) throw new Error('WEB_PASSWORD is configured but empty.')
    return configured
  }

  const envPath = options.envPath ?? '.env'
  const makeRandomBytes = options.randomBytes ?? randomBytes
  const result = await ensureEnvVariableAtomic(envPath, 'WEB_PASSWORD', () => {
    const bytes = makeRandomBytes(24)
    if (bytes.byteLength !== 24) throw new Error('Password generator did not return 24 bytes.')
    return bytes.toString('base64url')
  })

  env.WEB_PASSWORD = result.value
  if (result.created) {
    const stdout = options.stdout ?? process.stdout
    stdout.write(`A new web password was generated and saved to ${envPath}.\n`)
  }
  return result.value
}
