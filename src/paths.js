import path from 'node:path'

export function normalizeRemote(input = '/', cwd = '/') {
  let value = String(input || '.')
  value = value.replaceAll('\\', '/')
  const joined = value.startsWith('/') ? value : path.posix.join(cwd, value)
  const normalized = path.posix.normalize(joined)
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function encodeRemote(remotePath) {
  return normalizeRemote(remotePath)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

export function remoteJoin(...parts) {
  return normalizeRemote(path.posix.join(...parts.map((part) => String(part).replaceAll('\\', '/'))))
}

export function remoteBase(remotePath) {
  return path.posix.basename(normalizeRemote(remotePath))
}

export function remoteDir(remotePath) {
  return path.posix.dirname(normalizeRemote(remotePath))
}
