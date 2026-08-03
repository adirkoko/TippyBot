import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadBotInstances } from '../../src/config/instances'

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
          profilesFolder: './auth_cache/steve'
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

  it('throws when "instances" is empty', async () => {
    await writeConfig({ instances: [] })

    expect(() => loadBotInstances(configPath)).toThrow(/empty/)
  })

  it('throws on a missing or invalid id', async () => {
    await writeConfig({ instances: [{ ...validInstance, id: 'bad id!' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"id"/)
  })

  it('throws on a missing host', async () => {
    const { host, ...rest } = validInstance
    await writeConfig({ instances: [rest] })

    expect(() => loadBotInstances(configPath)).toThrow(/"host"/)
  })

  it('throws on a non-numeric port', async () => {
    await writeConfig({ instances: [{ ...validInstance, port: '25565' }] })

    expect(() => loadBotInstances(configPath)).toThrow(/"port"/)
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
})
