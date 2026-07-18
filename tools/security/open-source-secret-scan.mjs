#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const outDir = path.resolve(root, process.env.FSUSBLOG_OPEN_SOURCE_READINESS_OUT_DIR ?? '.tmp/open-source-readiness')
const jsonOut = path.join(outDir, 'secret-scan.json')
const mdOut = path.join(outDir, 'secret-scan.md')

const denyPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/u],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['github token', /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/u],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u],
  ['generic secret assignment', /\b(?:secret|token|password|passwd|pwd|api[_-]?key)\b\s*[:=]\s*(?:"[A-Za-z0-9/+_.~!@#$%^&*=-]{24,}"|'[A-Za-z0-9/+_.~!@#$%^&*=-]{24,}'|[A-Za-z0-9/+_~!@#$%^&*=-]{32,})/iu],
  ['production ip address', /\b(?!(?:127|10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.)(?:\d{1,3}\.){3}\d{1,3}\b/u],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu]
]

const allowedValuePattern = /(?:replace|example|localhost|127\.0\.0\.1|0\.0\.0\.0|ChangeMe|changeme|demo|fictional|sample|placeholder|your_|your-|fsusblog_dev|BinaryAdminPass123|TestPassword|Password123|example\.com|test\.com|schemas\.openxmlformats\.org|www\.w3\.org)/iu
const skipPathPattern = /(?:^|\/)(?:\.git|\.tmp|node_modules|bin|obj|coverage|TestResults|test-results|playwright-report|docs\/reports\/open-source-readiness)(?:\/|$)|package-lock\.json$|packages\.lock\.json$|\.(?:png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip|gz|dll|so|wasm|pdf)$/iu
const documentationIpPattern = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/u
const placeholderIps = new Set(['1.2.3.4'])
const publicResolverIps = new Set(['1.1.1.1', '8.8.8.8', '8.8.4.4'])
const crawlerFixturePattern = /(?:Crawler|crawler|Googlebot|Bingbot|IpRadixTree|66\.249\.|40\.77\.)/u
const packageVersionPattern = /\b(?:SqlSugar|Kdbndp|version|Version|PackageReference|nuget:|npm:)\b|@\d+\.\d+\.\d+\.\d+/u
const publicResolverContextPattern = /(?:DNS_RESOLVERS|dnsResolvers|resolver|dns\/|publicResolverIps|test-production-exposure-tools|VisitLogProcessorServiceTests|CreateMessage|PublicIp_DoesNotMatch)/u

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 80, ...options })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status
  }
}

function trackedFiles() {
  return run('git', ['ls-files', '--cached', '--others', '--exclude-standard']).stdout.split(/\r?\n/u).filter(Boolean)
}

function firstIpv4(line) {
  return line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u)?.[0] ?? null
}

function validIpv4(ip) {
  return ip.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
}

function isAllowedFinding(kind, source, line) {
  if (allowedValuePattern.test(line)) return true
  if (kind === 'email address') return /(?:@test\.com|@example\.(?:com|net|org))\b/iu.test(line)
  if (kind === 'generic secret assignment') return /(?:^|\s):password=|v-model:|@update:/u.test(line)
  if (kind !== 'production ip address') return false

  const ip = firstIpv4(line)
  if (!ip || !validIpv4(ip)) return true
  if (documentationIpPattern.test(ip) || placeholderIps.has(ip)) return true
  if (publicResolverIps.has(ip) && (publicResolverContextPattern.test(line) || publicResolverContextPattern.test(source))) return true
  if (packageVersionPattern.test(line)) return true
  if (crawlerFixturePattern.test(line) || crawlerFixturePattern.test(source)) return true
  if (source.endsWith('src/backend/Dictionaries/SensitiveWords.txt')) return true
  return false
}

function scanText(scope, source, text) {
  const findings = []
  for (const [kind, pattern] of denyPatterns) {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const match = line.match(pattern)
      if (!match) continue
      if (isAllowedFinding(kind, source, line)) continue
      findings.push({
        scope,
        source,
        line: index + 1,
        kind,
        sample: line.slice(0, 160)
      })
    }
  }
  return findings
}

function scanCurrentTree() {
  const findings = []
  let scanned = 0
  for (const file of trackedFiles()) {
    if (skipPathPattern.test(file)) continue
    const abs = path.join(root, file)
    if (!fs.existsSync(abs) || fs.statSync(abs).size > 1024 * 1024 * 2) continue
    const text = fs.readFileSync(abs, 'utf8')
    scanned += 1
    findings.push(...scanText('current-tree', file, text))
  }
  return { scanned, findings }
}

function scanHistory() {
  const revisions = run('git', ['rev-list', '--all']).stdout.split(/\r?\n/u).filter(Boolean)
  const objectPaths = new Map()
  for (const line of run('git', ['rev-list', '--objects', '--all']).stdout.split(/\r?\n/u)) {
    const match = line.match(/^([0-9a-f]{40})(?:\s+(.+))?$/u)
    if (!match?.[2]) continue
    const [, objectId, file] = match
    if (skipPathPattern.test(file)) continue
    if (!objectPaths.has(objectId)) objectPaths.set(objectId, file)
  }
  const batchInput = `${[...objectPaths.keys()].join('\n')}\n`
  const objectMeta = run('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: batchInput })
  const findings = []
  let scanned = 0
  for (const line of objectMeta.stdout.split(/\r?\n/u)) {
    const match = line.match(/^([0-9a-f]{40})\s+(\w+)\s+(\d+)$/u)
    if (!match) continue
    const [, objectId, objectType, objectSize] = match
    if (objectType !== 'blob' || Number(objectSize) > 1024 * 1024 * 2) continue
    const file = objectPaths.get(objectId)
    const blob = run('git', ['cat-file', 'blob', objectId])
    if (!blob.ok) continue
    scanned += 1
    findings.push(...scanText('git-history', `${objectId.slice(0, 12)}:${file}`, blob.stdout))
  }
  return { revisions: revisions.length, scanned, findings }
}

function scanGithubIssues() {
  const gh = run('gh', ['issue', 'list', '--repo', 'Ozwasyd/FsusBlog', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,comments'])
  if (!gh.ok) {
    return { available: false, scanned: 0, findings: [], error: gh.stderr.trim() || gh.stdout.trim() }
  }
  const issues = JSON.parse(gh.stdout)
  const findings = []
  for (const issue of issues) {
    findings.push(...scanText('github-issues', `#${issue.number} ${issue.title}`, issue.body ?? ''))
    for (const comment of issue.comments ?? []) {
      findings.push(...scanText('github-issue-comments', `#${issue.number} comment ${comment.id ?? ''}`, comment.body ?? ''))
    }
  }
  return { available: true, scanned: issues.length, findings }
}

function docsImages() {
  return trackedFiles().filter((file) => /^docs\/assets\//u.test(file) && /\.(?:png|jpg|jpeg|webp|gif)$/iu.test(file))
}

function writeEvidence(summary) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
  const lines = [
    '# Open Source Readiness Secret Scan',
    '',
    `Status: ${summary.status}`,
    `Generated at: ${summary.generatedAt}`,
    `Git head: ${summary.gitHead}`,
    '',
    '## Scope',
    '',
    `- Current tracked tree files scanned: ${summary.currentTree.scanned}`,
    `- Git history revisions scanned: ${summary.gitHistory.revisions}`,
    `- Git history blobs scanned: ${summary.gitHistory.scanned}`,
    `- GitHub issues scanned: ${summary.githubIssues.available ? summary.githubIssues.scanned : `unavailable (${summary.githubIssues.error})`}`,
    `- Docs images inventoried: ${summary.docsImages.length}`,
    '- Config files, CI files, test fixtures, docs, and examples are included through tracked-tree and history scans.',
    '',
    '## Result',
    '',
    summary.findings.length === 0
      ? 'No unapproved secret, token, private key, production IP, personal email, or production-looking credential pattern was found.'
      : `Findings requiring review: ${summary.findings.length}`
  ]
  if (summary.findings.length > 0) lines.push('')
  for (const finding of summary.findings.slice(0, 50)) {
    lines.push(`- ${finding.scope} ${finding.source}:${finding.line} ${finding.kind}: \`${finding.sample.replaceAll('`', "'")}\``)
  }
  fs.writeFileSync(mdOut, `${lines.join('\n')}\n`)
}

const currentTree = scanCurrentTree()
const gitHistory = scanHistory()
const githubIssues = scanGithubIssues()
const findings = [...currentTree.findings, ...gitHistory.findings, ...githubIssues.findings]
const summary = {
  schema: 'fsusblog.open-source.secret-scan.v1',
  status: findings.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  gitHead: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
  currentTree: { scanned: currentTree.scanned },
  gitHistory: { revisions: gitHistory.revisions, scanned: gitHistory.scanned },
  githubIssues: { available: githubIssues.available, scanned: githubIssues.scanned, error: githubIssues.error ?? null },
  docsImages: docsImages(),
  findings
}
writeEvidence(summary)
console.log(`[open-source-secret-scan] ${summary.status} findings=${findings.length}`)
if (findings.length > 0) process.exit(1)
