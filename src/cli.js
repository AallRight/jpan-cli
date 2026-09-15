import process from 'node:process'
import { JPanClient } from './client.js'
import { clearConfig, configPath, loadConfig, parseCredentialInput, saveConfig } from './config.js'
import { formatList, progressPrinter } from './format.js'
import { normalizeRemote } from './paths.js'
import { readSecret } from './prompt.js'
import { download, summarize, upload } from './transfer.js'

const HELP = `jpan - 上海交通大学云盘命令行客户端

用法:
  jpan login                     安全输入 USER_TOKEN 或完整 Cookie
  jpan logout                    删除本机保存的凭据
  jpan status                    检查登录状态
  jpan shell                     进入交互式命令行
  jpan pwd                       显示远端当前目录
  jpan cd <远端目录>             切换并保存远端当前目录
  jpan ls [远端目录] [-l]        列出文件
  jpan mkdir <远端目录>          递归创建目录
  jpan upload <本地路径> [远端]  上传单个文件或整个文件夹
  jpan download <远端> [本地]    下载单个文件或整个文件夹

传输选项:
  --conflict skip|overwrite|rename   同名处理，默认 skip
  --jobs N                          文件夹并发数，默认 3

环境变量:
  JPAN_USER_TOKEN   临时使用该 token，不写入配置
  JPAN_CONFIG_PATH  覆盖配置文件位置
  JPAN_DEBUG=1      输出错误堆栈

例子:
  jpan upload ./report.pdf /documents/report.pdf
  jpan upload ./photos /backup
  jpan download /documents/report.pdf .
  jpan download /photos ./restore --jobs 4
`

function parseOptions(args) {
  const positional = []
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]
    if (value === '-l' || value === '--long') options.long = true
    else if (value === '--overwrite') options.conflict = 'overwrite'
    else if (value === '--skip') options.conflict = 'skip'
    else if (value === '--jobs') options.jobs = Number(args[++i])
    else if (value.startsWith('--jobs=')) options.jobs = Number(value.slice(7))
    else if (value === '--conflict') options.conflict = args[++i]
    else if (value.startsWith('--conflict=')) options.conflict = value.slice(11)
    else if (value === '--stdin') options.stdin = true
    else if (value === '--help' || value === '-h') options.help = true
    else if (value.startsWith('-')) throw new Error(`未知选项: ${value}`)
    else positional.push(value)
  }
  if (options.jobs !== undefined && (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 32)) {
    throw new Error('--jobs 必须是 1 到 32 的整数')
  }
  if (options.conflict && !['skip', 'overwrite', 'rename'].includes(options.conflict)) {
    throw new Error('--conflict 必须是 skip、overwrite 或 rename')
  }
  return { positional, options }
}

async function ensureLogin(config) {
  if (process.env.JPAN_USER_TOKEN) return { ...config, userToken: process.env.JPAN_USER_TOKEN }
  if (config.userToken) return config
  if (!process.stdin.isTTY) throw new Error('尚未登录，请运行 jpan login，或设置 JPAN_USER_TOKEN')
  process.stderr.write('首次使用需要交大云盘凭据。请登录 pan.sjtu.edu.cn 后复制 USER_TOKEN 或完整 Cookie。\n')
  const raw = await readSecret('Cookie / USER_TOKEN: ')
  const credential = parseCredentialInput(raw)
  const next = { ...config, ...credential }
  const client = new JPanClient(next)
  await client.getCredential()
  await saveConfig(next)
  process.stderr.write(`登录成功，凭据已保存到 ${configPath()}\n`)
  return next
}

async function login(config) {
  const raw = await readSecret('Cookie / USER_TOKEN: ')
  const credential = parseCredentialInput(raw)
  const next = { ...config, ...credential }
  const client = new JPanClient(next)
  await client.getCredential()
  await saveConfig(next)
  process.stdout.write(`登录成功。配置文件: ${configPath()}\n`)
}

function printSummary(results) {
  const summary = summarize(results)
  const parts = []
  if (summary.uploaded) parts.push(`上传 ${summary.uploaded}`)
  if (summary.downloaded) parts.push(`下载 ${summary.downloaded}`)
  if (summary.skipped) parts.push(`跳过 ${summary.skipped}`)
  if (summary.failed) parts.push(`失败 ${summary.failed}`)
  process.stdout.write(`${parts.join('，') || '没有文件需要处理'}\n`)
  if (summary.failed) {
    for (const result of results.filter((entry) => entry?.status === 'failed')) {
      process.stderr.write(`失败: ${result.item?.local || result.item?.remote || ''}: ${result.error?.message || result.error}\n`)
    }
    process.exitCode = 2
  }
}

async function execute(command, args, state, shellMode = false) {
  const { positional, options } = parseOptions(args)
  if (options.help) {
    process.stdout.write(HELP)
    return state
  }
  if (command === 'login') {
    await login(state.config)
    state.config = await loadConfig()
    state.client = new JPanClient(state.config)
    return state
  }
  if (command === 'logout') {
    await clearConfig()
    state.config = { userToken: '', keepAlive: '', userId: '', cwd: '/' }
    state.client = null
    process.stdout.write('已删除本机保存的凭据。\n')
    return state
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return state
  }

  state.config = await ensureLogin(state.config)
  state.client ||= new JPanClient(state.config)
  const client = state.client
  const cwd = state.config.cwd || '/'

  if (command === 'status') {
    const credential = await client.getCredential()
    process.stdout.write(`已登录；library=${credential.libraryId}，space=${credential.spaceId}，cwd=${cwd}\n`)
  } else if (command === 'pwd') {
    process.stdout.write(`${cwd}\n`)
  } else if (command === 'cd') {
    if (positional.length !== 1) throw new Error('用法: jpan cd <远端目录>')
    const target = normalizeRemote(positional[0], cwd)
    const info = await client.stat(target)
    if (!info || info.type !== 'directory') throw new Error(`远端目录不存在: ${target}`)
    state.config.cwd = target
    if (!process.env.JPAN_USER_TOKEN) await saveConfig(state.config)
    process.stdout.write(`${target}\n`)
  } else if (command === 'ls') {
    if (positional.length > 1) throw new Error('用法: jpan ls [远端目录] [-l]')
    const target = normalizeRemote(positional[0] || '.', cwd)
    const items = await client.list(target)
    const output = formatList(items, options.long)
    if (output) process.stdout.write(`${output}\n`)
  } else if (command === 'mkdir') {
    if (positional.length !== 1) throw new Error('用法: jpan mkdir <远端目录>')
    const target = normalizeRemote(positional[0], cwd)
    await client.mkdir(target)
    process.stdout.write(`已创建: ${target}\n`)
  } else if (command === 'upload' || command === 'put') {
    if (positional.length < 1 || positional.length > 2) throw new Error('用法: jpan upload <本地路径> [远端路径]')
    const results = await upload(client, positional[0], positional[1], {
      cwd,
      jobs: options.jobs,
      conflict: options.conflict || 'skip',
      onProgress: progressPrinter('上传'),
      onDiscover: (count) => process.stderr.write(`发现 ${count} 个文件，开始上传…\n`),
      onItem: (result, source) => process.stderr.write(`${result.status === 'skipped' ? '跳过' : '完成'}: ${source} -> ${result.path}\n`),
    })
    printSummary(results)
  } else if (command === 'download' || command === 'get') {
    if (positional.length < 1 || positional.length > 2) throw new Error('用法: jpan download <远端路径> [本地路径]')
    if (options.conflict === 'rename') throw new Error('下载不支持 rename，请使用 skip 或 overwrite')
    const results = await download(client, positional[0], positional[1], {
      cwd,
      jobs: options.jobs,
      conflict: options.conflict || 'skip',
      onProgress: progressPrinter('下载'),
      onDiscover: (count) => process.stderr.write(`发现 ${count} 个文件，开始下载…\n`),
      onItem: (result, source) => process.stderr.write(`${result.status === 'skipped' ? '跳过' : '完成'}: ${source} -> ${result.path}\n`),
    })
    printSummary(results)
  } else if (command === 'shell') {
    const { runShell } = await import('./shell.js')
    await runShell(state, execute)
  } else {
    throw new Error(`未知命令: ${command}。运行 jpan help 查看帮助`)
  }
  return state
}

export async function main(argv) {
  const config = await loadConfig()
  const state = { config, client: null }
  if (!argv.length) {
    if (process.stdin.isTTY) return execute('shell', [], state)
    process.stdout.write(HELP)
    return
  }
  await execute(argv[0], argv.slice(1), state)
}

export { execute, HELP }
