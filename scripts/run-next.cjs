#!/usr/bin/env node

const { spawn } = require('node:child_process')

const [mode = 'dev', host = '127.0.0.1', fallbackPort = '3000'] = process.argv.slice(2)
const port = process.env.PORT || fallbackPort
const nextBin = process.platform === 'win32' ? 'next.cmd' : 'next'

const child = spawn(nextBin, [mode, '--hostname', host, '--port', port], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(`Failed to start Next.js: ${error.message}`)
  process.exit(1)
})
