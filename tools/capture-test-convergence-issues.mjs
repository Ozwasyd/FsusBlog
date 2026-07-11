#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChildIssueStatusEvidence } from './test-convergence/audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = {
    out: resolve(root, '.tmp/release-evidence/issue-1051-child-issues.json'),
    repository: String(process.env.GITHUB_REPOSITORY ?? '').trim() || null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--out') {
      const value = argv[++index]
      if (!value) throw new Error('--out requires a path')
      options.out = resolve(root, value)
    } else if (argument === '--repository') {
      const value = argv[++index]
      if (!value) throw new Error('--repository requires owner/name')
      options.repository = value
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node tools/capture-test-convergence-issues.mjs [--repository owner/name] [--out <status.json>]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

function gh(args) {
  const result = spawnSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

function resolveRepository(explicitRepository) {
  const repository = explicitRepository
    ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`)
  }
  return repository
}

function capture(options) {
  const repository = resolveRepository(options.repository)
  const response = gh([
    'api',
    '--method', 'GET',
    `repos/${repository}/issues?state=all&per_page=100`
  ])
  const issues = JSON.parse(response)
  if (!Array.isArray(issues)) throw new Error('GitHub issue response must be an array')
  const evidence = buildChildIssueStatusEvidence(issues, { repository })
  mkdirSync(dirname(options.out), { recursive: true })
  const temporary = `${options.out}.next-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  renameSync(temporary, options.out)
  if (evidence.status !== 'closed') {
    const details = [
      evidence.missingIssueNumbers.length > 0 ? `missing=${evidence.missingIssueNumbers.join(',')}` : null,
      evidence.openIssueNumbers.length > 0 ? `open=${evidence.openIssueNumbers.join(',')}` : null
    ].filter(Boolean).join(' ')
    throw new Error(`child issues are not converged${details ? `: ${details}` : ''}`)
  }
  return evidence
}

try {
  const evidence = capture(parseArgs(process.argv.slice(2)))
  console.log(`[test-suite-convergence] child issues closed=${evidence.issueCount} repository=${evidence.repository}`)
} catch (error) {
  console.error(`[test-suite-convergence] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
