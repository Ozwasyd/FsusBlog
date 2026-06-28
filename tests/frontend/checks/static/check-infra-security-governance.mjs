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

const openResty = read('deploy/production-openresty.conf')
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
    violations.push(`deploy/production-openresty.conf: missing ${needle}`)
  }
}

const productionSettings = read('src/backend/appsettings.Production.json')
if (!/"AllowedHosts"\s*:\s*"fsus\.blog;www\.fsus\.blog"/.test(productionSettings)) {
  violations.push('src/backend/appsettings.Production.json: production must explicitly set AllowedHosts')
}

const dockerignore = read('.dockerignore')
for (const needle of ['.env', '.env.*', '!.env.example', '!.env.production-template']) {
  if (!dockerignore.split(/\r?\n/).includes(needle)) {
    violations.push(`.dockerignore: missing ${needle}`)
  }
}

const codeowners = read('.github/CODEOWNERS')
for (const needle of [
  '/config/zk/ @Ozwasyd',
  '/security/ @Ozwasyd',
  '/ops/docker/ @Ozwasyd',
  '/deploy/ @Ozwasyd',
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
if (!dockerfile.includes('sha256sum -c public/wasm/SHA256SUMS')) {
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
