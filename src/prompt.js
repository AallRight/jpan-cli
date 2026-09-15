import readline from 'node:readline'

export async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').trim()
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(prompt)
    const input = process.stdin
    const wasRaw = Boolean(input.isRaw)
    readline.emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    let value = ''

    const finish = (error) => {
      input.off('keypress', onKey)
      input.setRawMode(wasRaw)
      input.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }

    const onKey = (text, key) => {
      if (key?.ctrl && key.name === 'c') return finish(new Error('已取消'))
      if (key?.name === 'return' || key?.name === 'enter') return finish()
      if (key?.name === 'backspace') {
        if (value.length) {
          value = value.slice(0, -1)
          process.stdout.write('\b \b')
        }
        return
      }
      if (text && !key?.ctrl && !key?.meta) {
        value += text
        process.stdout.write('*')
      }
    }
    input.on('keypress', onKey)
  })
}
