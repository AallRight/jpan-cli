import readline from 'node:readline/promises'

function splitCommand(line) {
  const result = []
  const regex = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g
  let match
  while ((match = regex.exec(line))) {
    result.push((match[1] ?? match[2] ?? match[3]).replace(/\\"/g, '"'))
  }
  return result
}

export async function runShell(state, execute) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  process.stdout.write('jpan 交互模式；输入 help 查看命令，exit 退出。\n')
  try {
    while (true) {
      let line
      try { line = await terminal.question(`jpan:${state.config.cwd || '/'}> `) } catch { break }
      const argv = splitCommand(line.trim())
      if (!argv.length) continue
      if (argv[0] === 'exit' || argv[0] === 'quit') break
      try {
        await execute(argv[0], argv.slice(1), state, true)
      } catch (error) {
        process.stderr.write(`错误: ${error instanceof Error ? error.message : error}\n`)
      }
    }
  } finally {
    terminal.close()
  }
}

export { splitCommand }
