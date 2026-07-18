import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '..', '..')
const violations = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireContains(file, needle, message) {
  if (!read(file).includes(needle)) {
    violations.push(`${file}: ${message}`)
  }
}

const openResty = read('ops/gateway/production-openresty.conf')

function parseLimitRequestZones(source) {
  const zones = new Map()
  const pattern = /^\s*limit_req_zone\s+\S+\s+zone=([A-Za-z0-9_]+):([^\s;]+)\s+rate=([^\s;]+)\s*;/gm
  for (const match of source.matchAll(pattern)) {
    zones.set(match[1], { storage: match[2], rate: match[3] })
  }
  return zones
}

function parseLocationBlocks(source) {
  const locations = new Map()
  const pattern = /^\s*location\s+(.+?)\s*\{/gm
  for (const match of source.matchAll(pattern)) {
    const bodyStart = match.index + match[0].length
    let depth = 1
    let cursor = bodyStart
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      if (source[cursor] === '}') depth -= 1
      cursor += 1
    }
    if (depth !== 0) {
      violations.push(`ops/gateway/production-openresty.conf: unterminated location ${match[1]}`)
      continue
    }
    locations.set(match[1].trim(), source.slice(bodyStart, cursor - 1))
  }
  return locations
}

function parseLimitRequest(block) {
  const match = /^\s*limit_req\s+zone=([A-Za-z0-9_]+)\s+burst=(\d+)\s+nodelay\s*;/m.exec(block)
  return match ? { zone: match[1], burst: Number.parseInt(match[2], 10) } : null
}

const limitZones = parseLimitRequestZones(openResty)
for (const [zone, expectedRate] of [
  ['fsus_global_limit', '10r/s'],
  ['fsus_auth_limit', '5r/m'],
  ['fsus_admin_limit', '30r/m']
]) {
  const parsed = limitZones.get(zone)
  if (!parsed || parsed.rate !== expectedRate) {
    violations.push(`ops/gateway/production-openresty.conf: ${zone} must declare rate=${expectedRate}`)
  }
}

const locationBlocks = parseLocationBlocks(openResty)
for (const [selector, expectedZone] of [
  ['~ ^/api/binary/auth(/|$)', 'fsus_auth_limit'],
  ['~ ^/api/binary/admin(/|$)', 'fsus_admin_limit'],
  ['~ ^/api/binary/author(/|$)', 'fsus_admin_limit']
]) {
  const block = locationBlocks.get(selector)
  const limit = block ? parseLimitRequest(block) : null
  if (!limit || limit.zone !== expectedZone || limit.burst <= 0) {
    violations.push(`ops/gateway/production-openresty.conf: location ${selector} must use ${expectedZone} with a positive burst`)
  }
}

for (const needle of [
  'ssl_protocols TLSv1.2 TLSv1.3;',
  'ssl_ciphers ',
  'ssl_prefer_server_ciphers on;',
  'ssl_ecdh_curve X25519:secp384r1;',
  'ssl_session_tickets off;',
  'Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"',
  'Content-Security-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
  'X-Permitted-Cross-Domain-Policies "none"'
]) {
  if (!openResty.includes(needle)) {
    violations.push(`ops/gateway/production-openresty.conf: missing ${needle}`)
  }
}

const productionSettings = read('src/backend/appsettings.Production.json')
if (!/"AllowedHosts"\s*:\s*"fsus\.blog;www\.fsus\.blog"/.test(productionSettings)) {
  violations.push('src/backend/appsettings.Production.json: production must explicitly set AllowedHosts')
}

const dockerignore = read('.dockerignore')
for (const needle of ['.env', '.env.*', '!.env.example', '!.env.production.example']) {
  if (!dockerignore.split(/\r?\n/).includes(needle)) {
    violations.push(`.dockerignore: missing ${needle}`)
  }
}

const codeowners = read('.github/CODEOWNERS')
for (const needle of [
  '/config/zk/ @Ozwasyd',
  '/security/ @Ozwasyd',
  '/ops/ @Ozwasyd',
  '/config/deployment/ @Ozwasyd',
  '/src/backend/Infrastructure/PublicAot/ @Ozwasyd'
]) {
  if (!codeowners.includes(needle)) {
    violations.push(`.github/CODEOWNERS: missing ${needle}`)
  }
}

const dockerfile = read('ops/docker/FsusBlog.Server.Dockerfile')
if (!dockerfile.includes('git -c advice.detachedHead=false checkout --detach "${VCPKG_COMMIT}"')) {
  violations.push('ops/docker/FsusBlog.Server.Dockerfile: vcpkg checkout must detach exactly at the pinned commit')
}
if (!dockerfile.includes('(cd public/wasm && sha256sum -c SHA256SUMS)')) {
  violations.push('ops/docker/FsusBlog.Server.Dockerfile: wasm artifacts must be checksum-verified in the frontend build stage')
}

function walkWorkflows(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      walkWorkflows(path)
      continue
    }
    if (!/\.ya?ml$/.test(path)) {
      continue
    }

    const rel = relative(repoRoot, path).replace(/\\/g, '/')
    const content = readFileSync(path, 'utf8')
    const actionRef = /^\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s*#\s*(.+))?$/gm
    let match
    while ((match = actionRef.exec(content)) !== null) {
      const ref = match[2]
      const comment = match[3] ?? ''
      if (!/^[0-9a-f]{40}$/i.test(ref) || !/^v?\d/.test(comment.trim())) {
        violations.push(`${rel}: action ${match[1]} must be pinned to a 40-char SHA with the version tag in a comment`)
      }
    }
  }
}

walkWorkflows(resolve(repoRoot, '.github', 'workflows'))

if (violations.length > 0) {
  console.error('[check-infra-security-governance] failed')
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

console.log('[check-infra-security-governance] ok')
