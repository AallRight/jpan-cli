import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function defaultConfigPath() {
  if (process.env.JPAN_CONFIG_PATH) return path.resolve(process.env.JPAN_CONFIG_PATH)
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'jpan', 'config.json')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'jpan', 'config.json')
}

export function configPath() {
  return defaultConfigPath()
}

export async function loadConfig() {
  try {
    const raw = await fs.readFile(defaultConfigPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      userToken: typeof parsed.userToken === 'string' ? parsed.userToken : '',
      keepAlive: typeof parsed.keepAlive === 'string' ? parsed.keepAlive : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      cwd: typeof parsed.cwd === 'string' && parsed.cwd.startsWith('/') ? parsed.cwd : '/',
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { userToken: '', keepAlive: '', userId: '', cwd: '/' }
    throw new Error(`无法读取配置 ${defaultConfigPath()}: ${error.message}`)
  }
}

export async function saveConfig(config) {
  const target = defaultConfigPath()
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.tmp`
  const data = `${JSON.stringify(config, null, 2)}\n`
  await fs.writeFile(temp, data, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await fs.chmod(temp, 0o600)
  await fs.rename(temp, target)
}

export async function clearConfig() {
  try {
    await fs.unlink(defaultConfigPath())
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function parseCredentialInput(input) {
  const value = String(input || '').trim().replace(/^cookie\s*:\s*/i, '')
  if (!value) throw new Error('凭据不能为空')

  const result = { userToken: '', keepAlive: '', userId: '' }
  if (!value.includes('=') && !value.includes(';')) {
    result.userToken = value
    return result
  }

  for (const fragment of value.split(';')) {
    const index = fragment.indexOf('=')
    if (index < 0) continue
    const key = fragment.slice(0, index).trim().toLowerCase().replaceAll('-', '_')
    const val = fragment.slice(index + 1).trim()
    if (key === 'user_token' || key === 'usertoken') result.userToken = val
    if (key === 'keep_alive' || key === 'keepalive') result.keepAlive = val
    if (key === 'user_id' || key === 'userid') result.userId = val
  }
  if (!result.userToken) throw new Error('Cookie 中没有找到 USER_TOKEN')
  return result
}
