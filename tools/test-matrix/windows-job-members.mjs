import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { collectProcessIdentity } from '../test/process-identity.mjs'

const queryScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'windows-job-members.ps1'
)

function sameProcessIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function queryWindowsJobProcessIds(
  authority,
  { platform = authority?.platform ?? process.platform, execute = execFileSync } = {}
) {
  if (
    platform !== 'win32' ||
    authority?.kind !== 'windows-job-object' ||
    authority.platform !== 'win32' ||
    typeof authority.jobName !== 'string' ||
    !authority.jobName
  ) {
    return { status: 'unverifiable', reason: 'Windows Job query authority is incomplete' }
  }
  try {
    const output = execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        queryScript,
        '-JobName',
        authority.jobName
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000
      }
    )
    const parsed = JSON.parse(String(output).trim())
    if (
      !Array.isArray(parsed) ||
      parsed.some((pid) => !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0)
    ) {
      return { status: 'unverifiable', reason: 'Windows Job member query returned invalid process ids' }
    }
    return {
      status: 'verified',
      processIds: [...new Set(parsed.map(Number))].sort((left, right) => left - right)
    }
  } catch (error) {
    return {
      status: 'unverifiable',
      reason: `Windows Job member query failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

export function collectWindowsJobMemberIdentities(
  authority,
  {
    platform = authority?.platform ?? process.platform,
    queryProcessIds = queryWindowsJobProcessIds,
    collectIdentity = collectProcessIdentity,
    raceRetries = 2
  } = {}
) {
  for (let attempt = 0; attempt <= raceRetries; attempt += 1) {
    const before = queryProcessIds(authority, { platform })
    if (before?.status !== 'verified') {
      return {
        status: 'unverifiable',
        reason: before?.reason ?? 'Windows Job member query is unavailable'
      }
    }
    const identities = []
    let raced = false
    for (const pid of before.processIds) {
      const identity = collectIdentity(pid, { platform })
      if (identity.status !== 'verified') {
        if (['ENOENT', 'ESRCH'].includes(identity.code)) {
          raced = true
          break
        }
        return {
          status: 'unverifiable',
          reason: `Windows Job member ${pid} identity is unavailable: ${identity.reason}`
        }
      }
      identities.push(identity)
    }
    const after = queryProcessIds(authority, { platform })
    if (after?.status !== 'verified') {
      return {
        status: 'unverifiable',
        reason: after?.reason ?? 'Windows Job member recheck is unavailable'
      }
    }
    if (raced || !sameProcessIds(before.processIds, after.processIds)) continue
    return { status: 'verified', identities }
  }
  return {
    status: 'unverifiable',
    reason: 'Windows Job member list changed during every bounded identity snapshot'
  }
}
