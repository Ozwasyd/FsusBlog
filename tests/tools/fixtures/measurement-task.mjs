import fs from 'node:fs'
import process from 'node:process'

const [mode, ...args] = process.argv.slice(2)

if (mode === 'timed') {
  const [durationText, outputFile] = args
  const durationMs = Number(durationText)
  const startedAt = performance.now()
  await new Promise((resolve) => setTimeout(resolve, durationMs))
  fs.writeFileSync(outputFile, `${JSON.stringify({
    requestedDurationMs: durationMs,
    measuredDurationMs: performance.now() - startedAt
  })}\n`)
} else if (mode === 'disk-write') {
  const [outputFile, bytesText] = args
  const bytes = Number(bytesText)
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  const descriptor = fs.openSync(outputFile, 'w')
  let written = 0
  try {
    while (written < bytes) {
      written += fs.writeSync(descriptor, chunk, 0, Math.min(chunk.length, bytes - written))
    }
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
} else if (mode === 'disk-burn') {
  const [outputFile, durationText] = args
  const durationMs = Number(durationText)
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  const descriptor = fs.openSync(outputFile, 'w')
  const deadline = performance.now() + durationMs
  try {
    while (performance.now() < deadline) {
      for (let position = 0; position < 256 * 1024 * 1024; position += chunk.length) {
        fs.writeSync(descriptor, chunk, 0, chunk.length, position)
      }
      fs.fsyncSync(descriptor)
    }
  } finally {
    fs.closeSync(descriptor)
  }
} else if (mode === 'env-check') {
  const [name, outputFile] = args
  fs.writeFileSync(outputFile, `${JSON.stringify({
    present: typeof process.env[name] === 'string',
    valueLength: process.env[name]?.length ?? 0
  })}\n`)
} else if (mode === 'cgroup-proof') {
  const [outputFile] = args
  fs.writeFileSync(outputFile, `${JSON.stringify({
    cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim(),
    owner: process.env.FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER ?? null
  })}\n`)
} else {
  throw new Error(`unknown measurement task fixture mode: ${mode}`)
}
