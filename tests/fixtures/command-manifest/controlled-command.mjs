import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [eventDirectory, id, mode = 'barrier', value = '0'] = process.argv.slice(2)
if (!eventDirectory || !id) throw new Error('usage: controlled-command.mjs <event-directory> <id> [mode] [value]')

fs.mkdirSync(eventDirectory, { recursive: true })
if (mode === 'stubborn') process.on('SIGTERM', () => {})

function publish(name, content = '') {
  const destination = path.join(eventDirectory, `${id}.${name}`)
  const temporary = `${destination}.next-${process.pid}`
  fs.writeFileSync(temporary, content)
  fs.renameSync(temporary, destination)
}

function waitForRelease() {
  const releaseFile = path.join(eventDirectory, `${id}.release`)
  if (fs.existsSync(releaseFile)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled || !fs.existsSync(releaseFile)) return
      settled = true
      watcher.close()
      resolve()
    }
    const watcher = fs.watch(eventDirectory, (_eventType, filename) => {
      if (filename === path.basename(releaseFile)) finish()
    })
    watcher.on('error', reject)
    finish()
  })
}

publish('started', `${process.pid}\n`)

if (mode === 'fail') {
  process.stderr.write(`${id}:fixture-failure:${value}\n`)
  publish('failed', `${value}\n`)
  process.exit(Number(value))
}

if (mode === 'write') {
  fs.mkdirSync(path.dirname(value), { recursive: true })
  fs.writeFileSync(value, `${id}\n`)
}

if (mode === 'descendant') {
  const descendant = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    eventDirectory,
    `${id}-descendant`,
    'stubborn'
  ], {
    stdio: 'ignore'
  })
  publish('descendant-pid', `${descendant.pid}\n`)
}

publish('ready', `${process.pid}\n`)
if (mode !== 'complete') await waitForRelease()
publish('completed', `${process.pid}\n`)
