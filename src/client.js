import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { encodeRemote, normalizeRemote, remoteBase, remoteDir, remoteJoin } from './paths.js'

const DEFAULT_BASE_URL = 'https://pan.sjtu.edu.cn'

export class HttpError extends Error {
  constructor(message, status, body = '') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

export class ConflictError extends Error {
  constructor(remotePath) {
    super(`远端已存在: ${remotePath}`)
    this.name = 'ConflictError'
    this.remotePath = remotePath
  }
}

function isConflict(status, body) {
  return status === 409 || /SameNameDirectoryOrFileExists/i.test(body)
}

function toUploadURL(domain, objectPath) {
  const base = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  return new URL(objectPath, base.endsWith('/') ? base : `${base}/`).toString()
}

function errorDetail(error) {
  const parts = []
  let current = error
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (current.code) parts.push(current.code)
    if (current.syscall) parts.push(current.syscall)
    if (current.hostname) parts.push(current.hostname)
    if (current.message && current.message !== 'fetch failed') parts.push(current.message)
    current = current.cause
  }
  return [...new Set(parts)].join(' / ') || '未知网络错误'
}

function putFileStream(targetURL, headers, sourcePath, size, onProgress) {
  const target = new URL(targetURL)
  const transport = target.protocol === 'http:' ? http : https
  const requestHeaders = Object.fromEntries(new Headers(headers).entries())
  requestHeaders['content-length'] = String(size)

  return new Promise((resolve, reject) => {
    const request = transport.request(target, { method: 'PUT', headers: requestHeaders }, (response) => {
      const chunks = []
      let length = 0
      response.on('data', (chunk) => {
        if (length < 1024 * 1024) chunks.push(chunk)
        length += chunk.length
      })
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.setTimeout(120_000, () => request.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })))
    request.on('error', reject)

    const stream = fs.createReadStream(sourcePath)
    let uploaded = 0
    stream.on('data', (chunk) => {
      uploaded += chunk.length
      onProgress?.(uploaded, size)
    })
    stream.on('error', (error) => request.destroy(error))
    stream.pipe(request)
  })
}

export class JPanClient {
  constructor(config, options = {}) {
    this.config = config
    this.baseURL = (options.baseURL || process.env.JPAN_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
    this.fetch = options.fetch || globalThis.fetch
    this.credential = null
    this.credentialExpiresAt = 0
  }

  cookieHeader() {
    const cookies = [`USER_TOKEN=${this.config.userToken}`]
    if (this.config.keepAlive) cookies.push(`keep_alive=${this.config.keepAlive}`)
    return cookies.join('; ')
  }

  async responseBody(response) {
    const text = await response.text()
    if (!response.ok) throw new HttpError(`HTTP ${response.status}: ${text.slice(0, 300)}`, response.status, text)
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`服务器返回了无效 JSON: ${text.slice(0, 200)}`)
    }
  }

  async getCredential(force = false) {
    if (!this.config.userToken) throw new Error('尚未登录，请先运行 jpan login')
    if (!force && this.credential && Date.now() < this.credentialExpiresAt - 60_000) return this.credential

    const url = new URL(`${this.baseURL}/user/v1/space/1/personal`)
    url.searchParams.set('user_token', this.config.userToken)
    let response
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', Cookie: this.cookieHeader() },
      })
    } catch (error) {
      throw new Error(`获取云盘访问凭据失败: ${errorDetail(error)}`, { cause: error })
    }
    const credential = await this.responseBody(response)
    if (!credential.accessToken || !credential.libraryId || !credential.spaceId) {
      throw new Error(`登录凭据响应不完整: ${JSON.stringify(credential).slice(0, 300)}`)
    }
    this.credential = credential
    this.credentialExpiresAt = Date.now() + (Number(credential.expiresIn) || 1800) * 1000
    return credential
  }

  fileURL(credential, remotePath) {
    const encoded = encodeRemote(remotePath)
    return `${this.baseURL}/api/v1/file/${encodeURIComponent(credential.libraryId)}/${encodeURIComponent(credential.spaceId)}/${encoded}`
  }

  directoryURL(credential, remotePath) {
    const encoded = encodeRemote(remotePath)
    const suffix = encoded ? `/${encoded}` : '/'
    return `${this.baseURL}/api/v1/directory/${encodeURIComponent(credential.libraryId)}/${encodeURIComponent(credential.spaceId)}${suffix}`
  }

  addCommonQuery(url, credential, includeUser = false) {
    const target = new URL(url)
    target.searchParams.set('access_token', credential.accessToken)
    target.searchParams.set('space_org_id', '1')
    const userId = this.config.userId || credential.userId || credential.userID || credential.id
    if (includeUser && userId) target.searchParams.set('user_id', String(userId))
    return target
  }

  async panFetch(url, options = {}, retry = true) {
    const headers = new Headers(options.headers || {})
    headers.set('Accept', headers.get('Accept') || 'application/json, text/plain, */*')
    headers.set('Cookie', this.cookieHeader())
    let response
    try {
      response = await this.fetch(url, { ...options, headers })
    } catch (error) {
      const method = options.method || 'GET'
      throw new Error(`交大云盘请求失败（${method} ${new URL(url).pathname}）: ${errorDetail(error)}`, { cause: error })
    }
    if (retry && (response.status === 401 || response.status === 403)) {
      this.credential = null
      this.credentialExpiresAt = 0
    }
    return response
  }

  async list(remotePath = '/', options = {}) {
    const target = normalizeRemote(remotePath)
    const pageSize = options.pageSize || 200
    const items = []
    let page = 1
    while (true) {
      const credential = await this.getCredential()
      const url = this.addCommonQuery(this.directoryURL(credential, target), credential)
      url.searchParams.set('page', String(page))
      url.searchParams.set('page_size', String(pageSize))
      url.searchParams.set('order_by', options.orderBy || 'name')
      url.searchParams.set('order_by_type', options.order || 'asc')
      const response = await this.panFetch(url)
      const data = await this.responseBody(response)
      const contents = Array.isArray(data.contents) ? data.contents : []
      items.push(...contents.map((item) => ({
        name: item.name,
        type: item.type === 'file' ? 'file' : 'directory',
        size: Number(item.size) || 0,
        modificationTime: item.modificationTime || '',
        creationTime: item.creationTime || '',
        contentType: item.contentType || '',
        path: remoteJoin(target, item.name),
      })))
      if (contents.length < pageSize || items.length >= (Number(data.totalNum) || 0)) break
      page += 1
    }
    return items
  }

  async stat(remotePath) {
    const target = normalizeRemote(remotePath)
    if (target === '/') return { name: '/', path: '/', type: 'directory', size: 0 }
    const entries = await this.list(remoteDir(target))
    return entries.find((entry) => entry.name === remoteBase(target)) || null
  }

  async mkdir(remotePath) {
    const target = normalizeRemote(remotePath)
    if (target === '/') return
    const segments = target.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = remoteJoin(current || '/', segment)
      const credential = await this.getCredential()
      const url = this.addCommonQuery(this.directoryURL(credential, current), credential, true)
      url.searchParams.set('conflict_resolution_strategy', 'ask')
      const response = await this.panFetch(url, { method: 'PUT' })
      if (response.ok || response.status === 409 || response.status === 400) continue
      await this.responseBody(response)
    }
  }

  async getDownloadURL(remotePath) {
    const credential = await this.getCredential()
    const url = this.addCommonQuery(this.fileURL(credential, remotePath), credential, true)
    url.searchParams.set('content_disposition', 'attachment')
    url.searchParams.set('purpose', 'download')
    const response = await this.panFetch(url, { method: 'GET', redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) await this.responseBody(response)
    const location = response.headers.get('location')
    if (!location) throw new Error('服务器未返回下载地址')
    return new URL(location, this.baseURL).toString()
  }

  async downloadFile(remotePath, localPath, options = {}) {
    const remote = normalizeRemote(remotePath)
    await fsPromises.mkdir(path.dirname(path.resolve(localPath)), { recursive: true })
    const destination = path.resolve(localPath)
    const partial = `${destination}.part`
    if (!options.overwrite) {
      try {
        await fsPromises.access(destination)
        return { status: 'skipped', path: destination, bytes: 0 }
      } catch {}
    }

    let offset = 0
    try { offset = (await fsPromises.stat(partial)).size } catch {}
    let response
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signedURL = await this.getDownloadURL(remote)
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {}
      try {
        response = await this.fetch(signedURL, { headers })
      } catch (error) {
        throw new Error(`下载数据连接失败: ${errorDetail(error)}`, { cause: error })
      }
      if (response.status !== 403 || attempt === 1) break
    }
    if (!response.ok && response.status !== 206) throw new HttpError(`下载失败: HTTP ${response.status}`, response.status)
    if (!response.body) throw new Error('下载响应没有数据')

    const append = offset > 0 && response.status === 206
    if (!append) offset = 0
    const totalRemaining = Number(response.headers.get('content-length')) || 0
    const total = offset + totalRemaining
    let received = offset
    const source = Readable.fromWeb(response.body)
    source.on('data', (chunk) => {
      received += chunk.length
      options.onProgress?.(received, total)
    })
    await pipeline(source, fs.createWriteStream(partial, { flags: append ? 'a' : 'w' }))
    if (options.overwrite) await fsPromises.rm(destination, { force: true })
    await fsPromises.rename(partial, destination)
    return { status: 'downloaded', path: destination, bytes: received }
  }

  async uploadFile(localPath, remotePath, options = {}) {
    const source = path.resolve(localPath)
    const info = await fsPromises.stat(source)
    if (!info.isFile()) throw new Error(`不是文件: ${source}`)
    const remote = normalizeRemote(remotePath)
    const strategy = options.conflict || 'skip'
    await this.mkdir(remoteDir(remote))

    const credential = await this.getCredential()
    const initURL = this.addCommonQuery(this.fileURL(credential, remote), credential, true)
    initURL.searchParams.set('conflict_resolution_strategy', strategy === 'skip' ? 'ask' : strategy)
    initURL.searchParams.set('filesize', String(info.size))
    const initResponse = await this.panFetch(initURL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const initText = await initResponse.text()
    if (isConflict(initResponse.status, initText)) throw new ConflictError(remote)
    if (!initResponse.ok) throw new HttpError(`初始化上传失败: HTTP ${initResponse.status}: ${initText.slice(0, 300)}`, initResponse.status, initText)
    let init
    try { init = JSON.parse(initText) } catch { throw new Error('初始化上传返回了无效 JSON') }
    if (!init.domain || !init.path || !init.confirmKey) throw new Error(`初始化上传响应不完整: ${initText.slice(0, 300)}`)

    const uploadURL = toUploadURL(init.domain, init.path)
    let uploadResponse
    try {
      uploadResponse = await putFileStream(uploadURL, init.headers || {}, source, info.size, options.onProgress)
    } catch (error) {
      throw new Error(`上传数据连接失败（${new URL(uploadURL).hostname}）: ${errorDetail(error)}`, { cause: error })
    }
    if (!uploadResponse.ok) {
      throw new HttpError(`上传数据失败: HTTP ${uploadResponse.status}: ${uploadResponse.body.slice(0, 300)}`, uploadResponse.status, uploadResponse.body)
    }

    const confirmURL = this.addCommonQuery(this.fileURL(credential, init.confirmKey), credential, true)
    confirmURL.searchParams.set('confirm', '')
    confirmURL.searchParams.set('conflict_resolution_strategy', strategy === 'skip' ? 'ask' : strategy)
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const confirmResponse = await this.panFetch(confirmURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const confirmText = await confirmResponse.text()
      if (confirmResponse.ok) {
        let result = {}
        try { result = confirmText ? JSON.parse(confirmText) : {} } catch {}
        return { status: 'uploaded', path: remote, bytes: info.size, result }
      }
      if (isConflict(confirmResponse.status, confirmText)) throw new ConflictError(remote)
      lastError = new HttpError(`确认上传失败: HTTP ${confirmResponse.status}: ${confirmText.slice(0, 300)}`, confirmResponse.status, confirmText)
      if (!(confirmResponse.status === 400 || confirmResponse.status >= 500) || attempt === 3) break
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)))
    }
    throw lastError
  }
}
