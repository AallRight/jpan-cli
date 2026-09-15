import fs from 'node:fs/promises'
import path from 'node:path'
import { ConflictError } from './client.js'
import { normalizeRemote, remoteBase, remoteJoin } from './paths.js'

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { status: 'failed', item: items[index], error }
      }
    }
  })
  await Promise.all(runners)
  return results
}

async function walkLocal(root) {
  const files = []
  const directories = []
  async function visit(current, relative) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const local = path.join(current, entry.name)
      const rel = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        directories.push(rel)
        await visit(local, rel)
      }
      else if (entry.isFile()) files.push({ local, relative: rel })
      else if (entry.isSymbolicLink()) {
        // Symlinks are deliberately skipped to avoid escaping the selected tree.
      }
    }
  }
  await visit(root, '')
  return { files, directories }
}

async function walkRemote(client, root) {
  const files = []
  const directories = []
  async function visit(current, relative) {
    const entries = await client.list(current)
    for (const entry of entries) {
      const rel = path.join(relative, entry.name)
      if (entry.type === 'directory') {
        directories.push(rel)
        await visit(entry.path, rel)
      }
      else files.push({ remote: entry.path, relative: rel, size: entry.size })
    }
  }
  await visit(root, '')
  return { files, directories }
}

export async function upload(client, localInput, remoteInput, options = {}) {
  const local = path.resolve(localInput)
  const info = await fs.stat(local)
  const cwd = options.cwd || '/'
  const requested = normalizeRemote(remoteInput || '.', cwd)
  const remoteInfo = remoteInput ? await client.stat(requested).catch(() => null) : { type: 'directory' }
  const jobs = Number(options.jobs) || 3
  const conflict = options.conflict || 'skip'

  if (info.isFile()) {
    const target = !remoteInput || remoteInfo?.type === 'directory' || String(remoteInput).endsWith('/')
      ? remoteJoin(requested, path.basename(local))
      : requested
    try {
      return [await client.uploadFile(local, target, { conflict, onProgress: options.onProgress })]
    } catch (error) {
      if (error instanceof ConflictError && conflict === 'skip') return [{ status: 'skipped', path: target, bytes: 0 }]
      throw error
    }
  }
  if (!info.isDirectory()) throw new Error(`不支持的本地文件类型: ${local}`)

  const root = remoteJoin(requested, path.basename(local))
  await client.mkdir(root)
  const tree = await walkLocal(local)
  for (const directory of tree.directories) {
    await client.mkdir(remoteJoin(root, directory.split(path.sep).join('/')))
  }
  options.onDiscover?.(tree.files.length)
  return mapLimit(tree.files, jobs, async (file) => {
    const target = remoteJoin(root, file.relative.split(path.sep).join('/'))
    try {
      const result = await client.uploadFile(file.local, target, { conflict })
      options.onItem?.(result, file.local)
      return result
    } catch (error) {
      if (error instanceof ConflictError && conflict === 'skip') {
        const result = { status: 'skipped', path: target, bytes: 0 }
        options.onItem?.(result, file.local)
        return result
      }
      throw error
    }
  })
}

export async function download(client, remoteInput, localInput, options = {}) {
  const cwd = options.cwd || '/'
  const remote = normalizeRemote(remoteInput, cwd)
  const info = await client.stat(remote)
  if (!info) throw new Error(`远端不存在: ${remote}`)
  const jobs = Number(options.jobs) || 3
  const baseLocal = path.resolve(localInput || '.')

  if (info.type === 'file') {
    let destination = baseLocal
    try {
      const localInfo = await fs.stat(baseLocal)
      if (localInfo.isDirectory()) destination = path.join(baseLocal, info.name)
    } catch {
      if (!localInput || String(localInput).endsWith(path.sep) || String(localInput).endsWith('/')) {
        destination = path.join(baseLocal, info.name)
      }
    }
    return [await client.downloadFile(remote, destination, {
      overwrite: options.conflict === 'overwrite',
      onProgress: options.onProgress,
    })]
  }

  const root = path.join(baseLocal, remoteBase(remote))
  await fs.mkdir(root, { recursive: true })
  const tree = await walkRemote(client, remote)
  for (const directory of tree.directories) {
    await fs.mkdir(path.join(root, directory), { recursive: true })
  }
  options.onDiscover?.(tree.files.length)
  return mapLimit(tree.files, jobs, async (file) => {
    const destination = path.join(root, file.relative)
    const result = await client.downloadFile(file.remote, destination, { overwrite: options.conflict === 'overwrite' })
    options.onItem?.(result, file.remote)
    return result
  })
}

export function summarize(results) {
  const summary = { uploaded: 0, downloaded: 0, skipped: 0, failed: 0 }
  for (const result of results) {
    const status = result?.status
    if (status in summary) summary[status] += 1
    else if (status === 'failed') summary.failed += 1
  }
  return summary
}
