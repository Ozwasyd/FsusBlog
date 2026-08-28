import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalDigest } from './execution-replay-contract.mjs'

export const playwrightReplayDecisionSchema = 'fsusblog.playwright-replay-decision.v1'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultDecisionFile = path.join(root, 'config/testing/playwright-replay-decision.json')

function sha256File(file)
{
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
}

function resolveOwned(relative, label)
{
    if (typeof relative !== 'string' || path.isAbsolute(relative))
    {
        throw new Error(`${label} must be a repository-relative path`)
    }
    const absolute = path.resolve(root, relative)
    const rel = path.relative(root, absolute)
    if (rel === '..' || rel.startsWith(`..${path.sep}`))
    {
        throw new Error(`${label} escapes repository`)
    }
    return absolute
}

export function loadPlaywrightReplayDecision(file = defaultDecisionFile)
{
    return JSON.parse(readFileSync(file, 'utf8'))
}

export function validatePlaywrightReplayDecision(decision, {
    expectedVersion = null,
    verifyFiles = true
} = {})
{
    if (decision?.schema !== playwrightReplayDecisionSchema
    || decision.status !== 'selected'
    || decision.selectedAdapter !== 'repo-owned-n-lane'
    || decision.rejectedAdapter !== 'maintained-playwright-dispatch-api')
    {
        throw new Error('Playwright replay decision is not exact-one selected')
    }
    if (!/^\d+\.\d+\.\d+$/u.test(String(decision.playwright?.version ?? '')))
    {
        throw new Error('Playwright replay decision version is invalid')
    }
    if (expectedVersion && decision.playwright.version !== expectedVersion)
    {
        throw new Error(`Playwright replay version drift: expected ${decision.playwright.version}, got ${expectedVersion}`)
    }
    if (decision.capabilities?.sealedPublicDispatchApi !== false
    || decision.capabilities?.testListCli !== true
    || decision.capabilities?.reporterIsPreDispatch !== false
    || decision.capabilities?.workerRestartIdentity !== true)
    {
        throw new Error('Playwright replay capability decision is incomplete')
    }
    if (decision.laneModel?.childWorkers !== 1
    || decision.laneModel?.ordinaryMinimumLanes !== 2
    || decision.laneModel?.parallel !== true)
    {
        throw new Error('Playwright replay decision weakened parallel lane semantics')
    }
    if (verifyFiles)
    {
        for (const [field, binding] of Object.entries({
            adr: decision.adr,
            probe: decision.probe,
            lock: { path: decision.playwright.lockPath, digest: decision.playwright.lockDigest },
            config: {
                path: decision.configuration.configPath,
                digest: decision.configuration.configDigest
            },
            globalSetup: {
                path: decision.configuration.globalSetupPath,
                digest: decision.configuration.globalSetupDigest
            }
        }))
        {
            const absolute = resolveOwned(binding?.path, `Playwright decision ${field}`)
            if (sha256File(absolute) !== binding.digest)
            {
                throw new Error(`Playwright replay decision ${field} digest drift`)
            }
        }
    }
    const expectedDigest = canonicalDigest({ ...decision, contentDigest: null })
    if (decision.contentDigest !== expectedDigest)
    {
        throw new Error('Playwright replay decision content digest mismatch')
    }
    return decision
}

export function fileDigest(file)
{
    return sha256File(resolveOwned(file, 'Playwright decision file'))
}
