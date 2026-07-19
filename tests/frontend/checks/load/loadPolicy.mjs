import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const policyFile = path.join(root, 'tests/performance/perf-policy.yml')

function readPolicyText() {
  return fs.readFileSync(policyFile, 'utf8')
}

function section(text, name, indent = 0) {
  const prefix = ' '.repeat(indent)
  const pattern = new RegExp(`(?:^|\\n)${prefix}${name}:\\n([\\s\\S]*?)(?=\\n${prefix}\\S|$)`, 'u')
  return text.match(pattern)?.[1] ?? ''
}

function scalarMap(text) {
  const values = {}
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(\d+)\s*$/u)
    if (match) values[match[1]] = Number(match[2])
  }
  return values
}

export function readLoadProfile(profile = 'baseline') {
  const text = readPolicyText()
  const profiles = section(text, 'loadProfiles')
  return scalarMap(section(profiles, profile, 2))
}

export function readNotificationPressurePolicy() {
  return scalarMap(section(readPolicyText(), 'notificationPressure'))
}
