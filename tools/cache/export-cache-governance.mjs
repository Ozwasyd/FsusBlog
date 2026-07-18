#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const outFile = path.join(root, 'docs/cache-governance.catalog.json')
const check = process.argv.includes('--check')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function parseTags() {
  const source = read('src/backend/Infrastructure/Cache/CacheTag.cs')
  const enumBlock = source.match(/public enum CacheTag\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  const outputMap = new Map()
  for (const match of source.matchAll(/CacheTag\.([A-Za-z0-9_]+)\s*=>\s*"([^"]+)"/g)) {
    outputMap.set(match[1], match[2])
  }

  return enumBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line) => line.replace(/,$/, ''))
    .map((line) => {
      const [name, rawValue] = line.split('=').map((part) => part.trim())
      return {
        name,
        value: Number(rawValue),
        outputCacheTag: outputMap.get(name) ?? name
      }
    })
}

function parsePolicies() {
  const source = read('src/backend/Infrastructure/Cache/CachePolicyRegistry.cs')
  const policies = []
  function splitArgs(value) {
    const args = []
    let current = ''
    let depth = 0
    let inString = false
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i]
      if (char === '"' && value[i - 1] !== '\\') inString = !inString
      if (!inString && (char === '(' || char === '[')) depth += 1
      if (!inString && (char === ')' || char === ']')) depth -= 1
      if (!inString && depth === 0 && char === ',') {
        args.push(current.trim())
        current = ''
        continue
      }
      current += char
    }
    if (current.trim()) args.push(current.trim())
    return args
  }

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/\[CachePolicyId\.([A-Za-z0-9_]+)\]\s*=\s*new\((.*)\),?/)
    if (!match) continue
    const args = splitArgs(match[2])
    const tagsArg = args[6] ?? 'null'
    const tags = tagsArg === 'null'
      ? []
      : Array.from(tagsArg.matchAll(/CacheTag\.([A-Za-z0-9_]+)/g)).map((tagMatch) => tagMatch[1])
    policies.push({
      id: match[1],
      domain: args[1]?.replaceAll('"', '') ?? '',
      resource: args[2]?.replaceAll('"', '') ?? '',
      l1Ttl: args[3] ?? '',
      l2Ttl: args[4] ?? '',
      negativeTtl: args[5] ?? 'null',
      invalidationTags: tags,
      securityCritical: args[7] === 'true',
      l2JitterRatio: Number((args[8] ?? '0').replace(/d$/, ''))
    })
  }
  return policies.sort((a, b) => a.id.localeCompare(b.id))
}

function parseHttpPolicies() {
  const source = read('src/backend/Infrastructure/Cache/HttpCachePolicyCatalog.cs')
  const policies = []
  const methodPattern = /public static void (Apply[A-Za-z0-9_]+)\(OutputCachePolicyBuilder builder\)\s*\{([\s\S]*?)\n    \}/g
  for (const match of source.matchAll(methodPattern)) {
    const body = match[2]
    policies.push({
      method: match[1],
      tags: Array.from(body.matchAll(/CacheTag\.([A-Za-z0-9_]+)\.ToOutputCacheTag\(\)/g)).map((tag) => tag[1]),
      varyByQuery: Array.from(body.matchAll(/SetVaryByQuery\(([^)]*)\)/g)).map((item) => item[1].replaceAll('"', '').split(',').map((value) => value.trim()).filter(Boolean)).flat(),
      varyByRouteValue: Array.from(body.matchAll(/SetVaryByRouteValue\(([^)]*)\)/g)).map((item) => item[1].replaceAll('"', '').split(',').map((value) => value.trim()).filter(Boolean)).flat()
    })
  }
  return policies
}

const catalog = {
  version: 1,
  generatedFrom: [
    'src/backend/Infrastructure/Cache/CachePolicyRegistry.cs',
    'src/backend/Infrastructure/Cache/CacheTag.cs',
    'src/backend/Infrastructure/Cache/HttpCachePolicyCatalog.cs'
  ],
  tags: parseTags(),
  policies: parsePolicies(),
  httpPolicies: parseHttpPolicies()
}

const next = `${JSON.stringify(catalog, null, 4)}\n`

if (check) {
  if (!fs.existsSync(outFile)) {
    console.error(`[cache-governance] missing ${path.relative(root, outFile)}`)
    process.exit(1)
  }
  const current = fs.readFileSync(outFile, 'utf8')
  if (current !== next) {
    console.error(`[cache-governance] ${path.relative(root, outFile)} is out of date; run tools/cache/export-cache-governance.mjs`)
    process.exit(1)
  }
  console.log('[cache-governance] catalog ok')
} else {
  fs.writeFileSync(outFile, next)
  console.log(`[cache-governance] wrote ${path.relative(root, outFile)}`)
}
