import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadBotInstances, saveBotInstances, validateInstance } from '../../src/config/instances'

let tmpDir: string
let configPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-instances-'))
  configPath = path.join(tmpDir, 'bots.config.json')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeConfig(contents: unknown): Promise<void> {
  await fs.writeFile(configPath, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
}

const validInstance = {
  id: 'steve',
  host: 'play.example.com',
  port: 25565,
  username: 'SteveBot',
  auth: 'microsoft',
  admins: ['PlayerOne']
}

describe('loadBotInstances', () => {
  it('loads and normalizes a valid single-instance config', () => {
    return writeConfig({ instances: [validInstance] }).then(() => {
      const configs = loadBotInstances(configPath)

      expect(configs).toEqual([
        {
          id: 'steve',
          host: 'play.example.com',
          port: 25565,
          username: 'SteveBot',
          auth: 'microsoft',
          commandPrefix: '!',
          admins: ['playerone'],
          profilesFolder: './auth_cache/steve',
          autoConnect: true,
          msaCacheKey: 'SteveBot'
        }
      ])
    })
  })

  it('loads multiple instances', async () => {
    await writeConfig({
      instances: [
        validInstance,
        { id: 'alex', host: 'other.example.com', port: 25565, username: 'AlexBot', auth: 'offline' }
      ]
    })

    const configs = loadBotInstances(configPath)

    expect(configs.map((c) => c.id)).toEqual(['steve', 'alex'])
    expect(configs[1].commandPrefix).toBe('!')
    expect(configs[1].admins).toEqual([])
    expect(configs[1].profilesFolder).toBe('./auth_cache/alex')
  })

  it('respects an explicit profilesFolder and commandPrefix', async () => {
    await writeConfig({
      instances: [{ ...validInstance, profilesFolder: './custom/profiles', commandPrefix: '?' }]
    })

    const configs = loadBotInstances(configPath)

    expect(configs[0].profilesFolder).toBe('./custom/profiles')
    expect(configs[0].commandPrefix).toBe('?')
  })

  it('rejects an absolute or traversal-escaping profilesFolder', async () => {
    await writeConfig({
      instances: [{ ...validInstance, profilesFolder: '../../etc' }]
    })

    expect(() => loadBotInstances(configPath)).toThrow(/"profilesFolder"/)
  })

  it('throws a clear error when the file does not exist', () => {
    expect(() => loadBotInstances(path.join(tmpDir, 'missing.json'))).toThrow(/not found/)
  })

  it('throws on invalid JSON', async () => {
    await writeConfig('{ not valid json')

    expect(() => loadBotInstances(configPath)).toThrow(/invalid JSON/)
  })

  it('throws when "instances" is missing or not an array', async () => {
    await writeConfig({})

    expect(() => loadBotInstances(configPath)).toThrow(/"instances" array/)
  })

  it('loads successfully with an empty instances array', async () => {
    await writeConfig({ instances: [] })

    expect(loadBotInstances(configPath)).toEqual([])
  })

  it('throws on a missing or invalid id', async () => {
    await writeConfig({ instances: [{ ...validInstance, id: 'bad id!' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"id"/)
  })

  it('loads a missing host/port as "unconfigured" instead of throwing', async () => {
    const { host, port, ...rest } = validInstance
    await writeConfig({ instances: [rest] })

    const configs = loadBotInstances(configPath)
    expect(configs[0].host).toBeUndefined()
    expect(configs[0].port).toBeUndefined()
  })

  it('defaults port to 25565 when host is given without one', async () => {
    const { port, ...rest } = validInstance
    await writeConfig({ instances: [rest] })

    expect(loadBotInstances(configPath)[0].port).toBe(25565)
  })

  it('throws on a non-numeric port when one is given', async () => {
    await writeConfig({ instances: [{ ...validInstance, port: '25565' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"port"/)
  })

  it('throws on an empty host string (distinct from an absent host)', async () => {
    await writeConfig({ instances: [{ ...validInstance, host: '' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"host"/)
  })

  it('defaults username to id for microsoft auth when omitted', async () => {
    const { username, ...rest } = validInstance // validInstance is auth: 'microsoft'
    await writeConfig({ instances: [rest] })

    expect(loadBotInstances(configPath)[0].username).toBe('steve')
  })

  it('also defaults username to id for microsoft auth when given as an empty string', async () => {
    await writeConfig({ instances: [{ ...validInstance, username: '' }] })

    expect(loadBotInstances(configPath)[0].username).toBe('steve')
  })

  it('still requires username for offline auth', async () => {
    const { username, ...rest } = validInstance
    await writeConfig({ instances: [{ ...rest, auth: 'offline' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"username"/)
  })

  it('throws on an invalid auth value', async () => {
    await writeConfig({ instances: [{ ...validInstance, auth: 'cracked' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"auth"/)
  })

  it('throws on an invalid admin username inside an instance', async () => {
    await writeConfig({ instances: [{ ...validInstance, admins: ['Bad Name'] }] })

    expect(() => loadBotInstances(configPath)).toThrow(/Invalid Minecraft username/)
  })

  it('throws on duplicate instance ids', async () => {
    await writeConfig({
      instances: [validInstance, { ...validInstance, host: 'other.example.com' }]
    })

    expect(() => loadBotInstances(configPath)).toThrow(/duplicate instance id/)
  })

  describe('autoConnect backward compatibility', () => {
    it('defaults to true when the field is absent, for configs written before it existed', async () => {
      await writeConfig({ instances: [validInstance] })

      const configs = loadBotInstances(configPath)

      expect(configs[0].autoConnect).toBe(true)
    })

    it('respects an explicit autoConnect: false', async () => {
      await writeConfig({ instances: [{ ...validInstance, autoConnect: false }] })

      const configs = loadBotInstances(configPath)

      expect(configs[0].autoConnect).toBe(false)
    })

    it('respects an explicit autoConnect: true', async () => {
      await writeConfig({ instances: [{ ...validInstance, autoConnect: true }] })

      const configs = loadBotInstances(configPath)

      expect(configs[0].autoConnect).toBe(true)
    })

    it('throws when autoConnect is not a boolean', async () => {
      await writeConfig({ instances: [{ ...validInstance, autoConnect: 'yes' }] })

      expect(() => loadBotInstances(configPath)).toThrow(/"autoConnect"/)
    })
  })
})

describe('validateInstance', () => {
  it('is reusable with a caller-supplied label, independent of array position', () => {
    expect(() => validateInstance({ ...validInstance, id: 'bad id!' }, 'New bot instance')).toThrow(
      /New bot instance: "id"/
    )
  })

  it('returns a fully-resolved IBotConfig including defaults', () => {
    const config = validateInstance(validInstance, 'New bot instance')

    expect(config).toEqual({
      id: 'steve',
      host: 'play.example.com',
      port: 25565,
      username: 'SteveBot',
      auth: 'microsoft',
      commandPrefix: '!',
      admins: ['playerone'],
      profilesFolder: './auth_cache/steve',
      autoConnect: true,
      msaCacheKey: 'SteveBot'
    })
  })

  it('defaults msaCacheKey to the resolved username, so an existing instance keeps its exact prismarine-auth cache key', () => {
    const config = validateInstance(validInstance, 'New bot instance')
    expect(config.msaCacheKey).toBe(config.username)
  })

  it('respects an explicit msaCacheKey, independent of username', () => {
    const config = validateInstance({ ...validInstance, msaCacheKey: 'stable-internal-id' }, 'New bot instance')
    expect(config.msaCacheKey).toBe('stable-internal-id')
    expect(config.username).toBe('SteveBot')
  })

  it('rejects an empty msaCacheKey', () => {
    expect(() => validateInstance({ ...validInstance, msaCacheKey: '' }, 'New bot instance')).toThrow(
      /"msaCacheKey"/
    )
  })
})

describe('saveBotInstances', () => {
  it('writes a file that loadBotInstances can read back identically', async () => {
    const configs = [
      validateInstance(validInstance, 'New bot instance'),
      validateInstance(
        { id: 'alex', host: 'other.example.com', port: 25565, username: 'AlexBot', auth: 'offline', autoConnect: false },
        'New bot instance'
      )
    ]

    await saveBotInstances(configs, configPath)
    const loaded = loadBotInstances(configPath)

    expect(loaded).toEqual(configs)
  })

  it('does not leave a temp file behind after a successful save', async () => {
    await saveBotInstances([validateInstance(validInstance, 'New bot instance')], configPath)

    const entries = await fs.readdir(path.dirname(configPath))
    const tmpFiles = entries.filter((name) => name.includes('.tmp'))
    expect(tmpFiles).toEqual([])
  })

  it('overwrites the full instance list rather than merging', async () => {
    const first = [validateInstance(validInstance, 'New bot instance')]
    const second = [
      validateInstance(
        { id: 'alex', host: 'other.example.com', port: 25565, username: 'AlexBot', auth: 'offline' },
        'New bot instance'
      )
    ]

    await saveBotInstances(first, configPath)
    await saveBotInstances(second, configPath)

    expect(loadBotInstances(configPath).map((c) => c.id)).toEqual(['alex'])
  })

  it('rejects without writing when the target path cannot be created, leaving any existing file untouched', async () => {
    const original = [validateInstance(validInstance, 'New bot instance')]
    await saveBotInstances(original, configPath)

    // A file occupying the path where a directory needs to be created makes
    // the underlying mkdir fail -- nothing about the existing config file
    // should change as a result.
    const blockedPath = path.join(tmpDir, 'not-a-directory', 'bots.config.json')
    await fs.writeFile(path.join(tmpDir, 'not-a-directory'), 'not a directory', 'utf8')

    await expect(saveBotInstances(original, blockedPath)).rejects.toThrow()
    expect(loadBotInstances(configPath)).toEqual(original)
  })
})
