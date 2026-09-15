#!/usr/bin/env node

import { main } from '../src/cli.js'

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`jpan: ${message}\n`)
  if (process.env.JPAN_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`)
  }
  process.exitCode = 1
})
