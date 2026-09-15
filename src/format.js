export function formatBytes(value) {
  let bytes = Number(value) || 0
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024
    unit += 1
  }
  return `${bytes.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatList(items, long = false) {
  if (!items.length) return ''
  if (!long) return items.map((item) => `${item.type === 'directory' ? 'd' : '-'} ${item.name}`).join('\n')
  const sizeWidth = Math.max(4, ...items.map((item) => formatBytes(item.size).length))
  return items.map((item) => {
    const kind = item.type === 'directory' ? 'd' : '-'
    const size = item.type === 'directory' ? '-' : formatBytes(item.size)
    const modified = item.modificationTime ? String(item.modificationTime).replace('T', ' ').slice(0, 19) : '-'
    return `${kind} ${size.padStart(sizeWidth)}  ${modified.padEnd(19)}  ${item.name}`
  }).join('\n')
}

export function progressPrinter(label) {
  let last = 0
  return (done, total) => {
    if (!process.stderr.isTTY) return
    const now = Date.now()
    if (done < total && now - last < 100) return
    last = now
    const percent = total ? Math.min(100, done / total * 100) : 0
    process.stderr.write(`\r${label}: ${percent.toFixed(1)}% (${formatBytes(done)}/${formatBytes(total)})`)
    if (done >= total) process.stderr.write('\n')
  }
}
