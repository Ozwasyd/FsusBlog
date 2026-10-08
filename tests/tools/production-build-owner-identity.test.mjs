import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    bindProductionBuildLayoutSource,
    collectStaleProductionBuildRoots,
    finalizeProductionBuildLayout,
    prepareProductionBuildLayout,
    productionBuildLayoutDigest,
    productionBuildRunIsActive,
    registerProductionBuildCompiler,
    scanProductionBuildProcesses,
    sealProductionBuildProcessTreeReceipt,
    verifyProductionBuildRootIntegrity
} from '../../tools/test-matrix/production-build-layout.mjs'
import {
    createSchedulerRunOwner,
    schedulerCandidateIdentityDigest,
    sealSchedulerRunOwner
} from '../../tools/test-matrix/scheduler-run-owner.mjs'
import { collectProcessIdentity, currentProcessIdentity } from '../../tools/test/process-identity.mjs'

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-build-owner-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function rewriteOwner(layout, transform) {
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
    manifest.owner = transform(manifest.owner)
    manifest.owner.processTreeReceipt = sealProductionBuildProcessTreeReceipt(manifest.owner)
    fs.writeFileSync(layout.manifestFile, `${JSON.stringify(manifest)}\n`)
    fs.writeFileSync(
        layout.activeFile,
        `${JSON.stringify({ schema: 'fsusblog.production-build-owner.v1', runId: layout.runId, owner: manifest.owner })}\n`
    )
}

function prepareBoundLayout(t, runId) {
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
    const namespace = `test:${runId}`
    const layout = prepareProductionBuildLayout({
        root: fixture(t),
        runId,
        sourceState,
        namespace,
        allowDiagnosticProcessContainmentForTests: true
    })
    const identity = currentProcessIdentity()
    const lock = path.join(layout.repositoryRoot, '.tmp/test-runs/.locks', `${runId}.lock`)
    fs.mkdirSync(lock, { recursive: true })
    fs.writeFileSync(
        path.join(lock, 'owner.json'),
        `${JSON.stringify(createSchedulerRunOwner({
            runId,
            targetTierId: 'fixture',
            candidateIdentityDigest: schedulerCandidateIdentityDigest({
                runId,
                targetTierId: 'fixture',
                namespace,
                sourceState
            }),
            ownerToken: `token-${runId}`,
            identity
        }))}\n`
    )
    bindProductionBuildLayoutSource(layout, sourceState)
    return layout
}

test('owner starts preparing with exact non-null run, source and namespace', (t) => {
    const sourceState = { commit: 'd'.repeat(40), worktreeFingerprint: 'e'.repeat(64) }
    const namespace = 'production:preparing'
    const layout = prepareProductionBuildLayout({
        root: fixture(t),
        runId: 'preparing-owner',
        sourceState,
        namespace
    })
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
    assert.equal(manifest.owner.state, 'preparing')
    assert.equal(manifest.owner.runId, layout.runId)
    assert.equal(manifest.owner.schedulerRunId, layout.runId)
    assert.equal(manifest.owner.namespace, namespace)
    assert.equal(manifest.owner.sourceCommit, sourceState.commit)
    assert.equal(manifest.owner.worktreeFingerprint, sourceState.worktreeFingerprint)
    assert.deepEqual(JSON.parse(fs.readFileSync(layout.activeFile, 'utf8')).owner, manifest.owner)
})

test('PID reuse does not retain an active build owner', (t) => {
    const layout = prepareBoundLayout(t, 'reused-owner')
    let reusedStartIdentity
    rewriteOwner(layout, (owner) => {
        reusedStartIdentity = `${owner.ownerIdentity.processStartIdentity}:reused`
        return {
            ...owner,
            ownerProcessStartIdentity: reusedStartIdentity,
            ownerIdentity: { ...owner.ownerIdentity, processStartIdentity: reusedStartIdentity },
            schedulerLockIdentity: sealSchedulerRunOwner({
                ...owner.schedulerLockIdentity,
                processStartIdentity: reusedStartIdentity
            })
        }
    })
    const lockFile = path.join(layout.repositoryRoot, '.tmp/test-runs/.locks', `${layout.runId}.lock/owner.json`)
    const lockOwner = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    lockOwner.processStartIdentity = reusedStartIdentity
    fs.writeFileSync(lockFile, `${JSON.stringify(sealSchedulerRunOwner(lockOwner))}\n`)
    assert.equal(productionBuildRunIsActive(layout.repositoryRoot, layout.runId), false)
})

test('a reused owner PID cannot inherit unrelated live descendants', async (t) => {
    const layout = prepareBoundLayout(t, 'reused-owner-descendants')
    const childPidFile = path.join(layout.repositoryRoot, 'unrelated-child.pid')
    const wrapper = spawn(
        process.execPath,
        [
            '-e',
            [
                "const { spawn } = require('node:child_process')",
                "const fs = require('node:fs')",
                "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })",
                `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))`,
                'setTimeout(() => {}, 5000)'
            ].join(';')
        ],
        { stdio: 'ignore' }
    )
    for (let attempt = 0; attempt < 100 && !fs.existsSync(childPidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'))
    t.after(() => {
        try {
            process.kill(childPid, 'SIGKILL')
        } catch {}
        try {
            wrapper.kill('SIGKILL')
        } catch {}
    })
    const wrapperIdentity = collectProcessIdentity(wrapper.pid)
    assert.equal(wrapperIdentity.status, 'verified')
    const reusedStartIdentity = `${wrapperIdentity.processStartIdentity}:reused`
    rewriteOwner(layout, (owner) => ({
        ...owner,
        ownerPid: wrapperIdentity.pid,
        ownerProcessStartIdentity: reusedStartIdentity,
        ownerExecutableDigest: wrapperIdentity.executableDigest,
        ownerCommandDigest: wrapperIdentity.commandDigest,
        ownerIdentity: { ...wrapperIdentity, processStartIdentity: reusedStartIdentity },
        schedulerLockIdentity: sealSchedulerRunOwner({
            ...owner.schedulerLockIdentity,
            pid: wrapperIdentity.pid,
            processStartIdentity: reusedStartIdentity,
            executableDigest: wrapperIdentity.executableDigest,
            commandDigest: wrapperIdentity.commandDigest
        })
    }))
    const lockFile = path.join(layout.repositoryRoot, '.tmp/test-runs/.locks', `${layout.runId}.lock/owner.json`)
    const lockOwner = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    Object.assign(lockOwner, {
        pid: wrapperIdentity.pid,
        processStartIdentity: reusedStartIdentity,
        executableDigest: wrapperIdentity.executableDigest,
        commandDigest: wrapperIdentity.commandDigest
    })
    fs.writeFileSync(lockFile, `${JSON.stringify(sealSchedulerRunOwner(lockOwner))}\n`)
    assert.equal(productionBuildRunIsActive(layout.repositoryRoot, layout.runId), false)
})

async function waitForFirstWriterOutput(outputFile) {
    const deadline = performance.now() + 5000
    while (true) {
        try {
            if (fs.statSync(outputFile).size > 0) return
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
        assert.ok(performance.now() < deadline, 'child writer did not produce its first output before the deadline')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

async function assertReparentedChildWriterRemainsActive(t, { holdFirstWrite = false } = {}) {
    const layout = prepareBoundLayout(t, 'compiler-child')
    const childFile = path.join(layout.repositoryRoot, 'writer.mjs')
    const wrapperFile = path.join(layout.repositoryRoot, 'wrapper.mjs')
    const pidFile = path.join(layout.repositoryRoot, 'writer.pid')
    const outputFile = path.join(layout.runRoot, 'writer-output')
    const firstWritePermitFile = path.join(layout.repositoryRoot, 'first-write-permit')
    const appendOutput = `fs.appendFileSync(${JSON.stringify(outputFile)}, 'x')`
    fs.writeFileSync(
        childFile,
        `import fs from 'node:fs'; setInterval(() => { ${holdFirstWrite ? `if (fs.existsSync(${JSON.stringify(firstWritePermitFile)})) ` : ''}${appendOutput} }, 20); setTimeout(() => process.exit(0), 5000)\n`
    )
    fs.writeFileSync(
        wrapperFile,
        `import { spawn } from 'node:child_process'; import fs from 'node:fs'; const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setTimeout(() => process.exit(0), 120)\n`
    )
    const wrapper = spawn(process.execPath, [wrapperFile], { detached: true, stdio: 'ignore' })
    const wrapperExited = new Promise((resolve) => wrapper.once('exit', resolve))
    t.after(() => {
        try {
            process.kill(-wrapper.pid, 'SIGKILL')
        } catch {}
    })
    let wrapperIdentity
    for (let attempt = 0; attempt < 50 && !wrapperIdentity; attempt += 1) {
        const identity = collectProcessIdentity(wrapper.pid)
        if (identity.status === 'verified') wrapperIdentity = identity
        else await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(wrapperIdentity)
    registerProductionBuildCompiler(layout, wrapperIdentity)
    for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10))
    await wrapperExited
    if (holdFirstWrite) {
        assert.equal(fs.existsSync(outputFile), false)
        const firstWritePermit = setImmediate(() => fs.writeFileSync(firstWritePermitFile, 'ready'))
        t.after(() => clearImmediate(firstWritePermit))
    }
    await waitForFirstWriterOutput(outputFile)
    scanProductionBuildProcesses(layout)
    const writerPid = Number(fs.readFileSync(pidFile, 'utf8'))
    const before = fs.statSync(outputFile).size
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.ok(fs.statSync(outputFile).size > before)
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
    assert.ok(manifest.owner.activeCompilerProcessIdentities.some((identity) => identity.pid === writerPid))
    assert.ok(
        manifest.owner.managedProcessGroupIdentities.some(
            (group) =>
                group.leaderPid === wrapper.pid &&
                group.leaderProcessStartIdentity === wrapperIdentity.processStartIdentity
        )
    )
    rewriteOwner(layout, (owner) => {
        const processStartIdentity = `${owner.ownerIdentity.processStartIdentity}:exited`
        return {
            ...owner,
            ownerProcessStartIdentity: processStartIdentity,
            ownerIdentity: { ...owner.ownerIdentity, processStartIdentity },
            schedulerLockIdentity: sealSchedulerRunOwner({
                ...owner.schedulerLockIdentity,
                processStartIdentity
            })
        }
    })
    fs.rmSync(path.join(layout.repositoryRoot, '.tmp/test-runs/.locks', `${layout.runId}.lock`), {
        recursive: true,
        force: true
    })
    assert.equal(productionBuildRunIsActive(layout.repositoryRoot, layout.runId), true)
}

test('scheduler exit keeps a reparented child writer active through persisted group monitoring', async (t) => {
    await assertReparentedChildWriterRemainsActive(t)
})

test('reparented child writer waits for its first output after scheduler exit before group assertions', async (t) => {
    await assertReparentedChildWriterRemainsActive(t, { holdFirstWrite: true })
})

test('unknown identities, incomplete markers, and active writers fail closed', (t) => {
    const layout = prepareBoundLayout(t, 'fail-closed')
    rewriteOwner(layout, (owner) => ({ ...owner, ownerIdentity: { ...owner.ownerIdentity, pid: 2_147_483_647 } }))
    assert.throws(
        () => productionBuildRunIsActive(layout.repositoryRoot, layout.runId),
        /identity mismatch|owner-unverifiable/u
    )

    const incomplete = prepareBoundLayout(t, 'incomplete-marker')
    const marker = JSON.parse(fs.readFileSync(incomplete.activeFile, 'utf8'))
    delete marker.owner.ownerProcessStartIdentity
    fs.writeFileSync(incomplete.activeFile, `${JSON.stringify(marker)}\n`)
    assert.throws(
        () => productionBuildRunIsActive(incomplete.repositoryRoot, incomplete.runId),
        /owner identity mismatch/u
    )

    const missing = prepareBoundLayout(t, 'missing-marker')
    fs.rmSync(missing.activeFile)
    assert.throws(() => productionBuildRunIsActive(missing.repositoryRoot, missing.runId), /owner identity is missing/u)
    assert.throws(
        () => collectStaleProductionBuildRoots({ root: missing.repositoryRoot }),
        /owner identity is missing/u
    )
    assert.equal(fs.existsSync(missing.runRoot), true)

    const unverifiable = prepareBoundLayout(t, 'unverifiable-owner')
    rewriteOwner(unverifiable, (owner) => ({ ...owner, processIdentityFailure: 'collector permission denied' }))
    assert.throws(
        () => collectStaleProductionBuildRoots({ root: unverifiable.repositoryRoot }),
        /process identity failure: collector permission denied/u
    )
    assert.equal(fs.existsSync(unverifiable.runRoot), true)

    const receiptMismatch = prepareBoundLayout(t, 'receipt-mismatch')
    const receiptManifest = JSON.parse(fs.readFileSync(receiptMismatch.manifestFile, 'utf8'))
    receiptManifest.owner.processTreeReceipt.namespace = 'tampered'
    fs.writeFileSync(receiptMismatch.manifestFile, `${JSON.stringify(receiptManifest)}\n`)
    fs.writeFileSync(
        receiptMismatch.activeFile,
        `${JSON.stringify({
            schema: 'fsusblog.production-build-owner.v1',
            runId: receiptMismatch.runId,
            owner: receiptManifest.owner
        })}\n`
    )
    assert.throws(
        () => productionBuildRunIsActive(receiptMismatch.repositoryRoot, receiptMismatch.runId),
        /owner identity mismatch/u
    )

    const writer = prepareBoundLayout(t, 'writer')
    const activeWriter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        detached: true,
        stdio: 'ignore'
    })
    t.after(() => {
        try {
            process.kill(-activeWriter.pid, 'SIGKILL')
        } catch {}
    })
    let activeWriterIdentity
    for (let attempt = 0; attempt < 50 && !activeWriterIdentity; attempt += 1) {
        const identity = collectProcessIdentity(activeWriter.pid)
        if (identity.status === 'verified') activeWriterIdentity = identity
    }
    registerProductionBuildCompiler(writer, activeWriterIdentity)
    assert.throws(() => finalizeProductionBuildLayout(writer, { status: 'success' }), /compiler writer is active/u)
})

test('a complete root rejects a later write instead of treating its marker as authority', (t) => {
    const layout = prepareBoundLayout(t, 'sealed-root')
    finalizeProductionBuildLayout(layout, { status: 'success' })
    assert.equal(verifyProductionBuildRootIntegrity(layout), true)
    assert.equal(productionBuildRunIsActive(layout.repositoryRoot, layout.runId), false)
    fs.writeFileSync(path.join(layout.runRoot, 'late-write'), 'forbidden')
    assert.throws(() => verifyProductionBuildRootIntegrity(layout), /complete root received a write/u)

    const failed = prepareBoundLayout(t, 'failed-root')
    finalizeProductionBuildLayout(failed, { status: 'failure' })
    assert.equal(verifyProductionBuildRootIntegrity(failed), true)
    assert.equal(productionBuildRunIsActive(failed.repositoryRoot, failed.runId), false)
    fs.writeFileSync(path.join(failed.runRoot, 'late-write'), 'forbidden')
    assert.throws(() => verifyProductionBuildRootIntegrity(failed), /failed root received a write/u)
})

test('owner receipt is canonical and excludes raw command arguments from the sealed manifest', (t) => {
    const layout = prepareBoundLayout(t, 'canonical-owner')
    const sourceDigest = productionBuildLayoutDigest(layout)
    const before = fs.readFileSync(layout.manifestFile, 'utf8')
    assert.doesNotMatch(before, /"command"\s*:/u)
    const compiler = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: 'ignore' })
    t.after(() => {
        try {
            process.kill(-compiler.pid, 'SIGKILL')
        } catch {}
    })
    registerProductionBuildCompiler(layout, collectProcessIdentity(compiler.pid))
    assert.equal(productionBuildLayoutDigest(layout), sourceDigest)
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
    assert.deepEqual(manifest.owner.processTreeReceipt, sealProductionBuildProcessTreeReceipt(manifest.owner))
    manifest.sourceState = {
        worktreeFingerprint: manifest.sourceState.worktreeFingerprint,
        commit: manifest.sourceState.commit
    }
    fs.writeFileSync(layout.manifestFile, `${JSON.stringify(manifest)}\n`)
    assert.equal(productionBuildLayoutDigest(layout), sourceDigest)
})

test('scheduler lock source mismatch and process-group leader reuse fail closed', (t) => {
    const sourceMismatch = prepareBoundLayout(t, 'source-mismatch')
    const lockFile = path.join(
        sourceMismatch.repositoryRoot,
        '.tmp/test-runs/.locks',
        `${sourceMismatch.runId}.lock/owner.json`
    )
    const lockOwner = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    lockOwner.candidateIdentityDigest = `sha256:${'c'.repeat(64)}`
    fs.writeFileSync(lockFile, `${JSON.stringify(sealSchedulerRunOwner(lockOwner))}\n`)
    assert.throws(
        () => productionBuildRunIsActive(sourceMismatch.repositoryRoot, sourceMismatch.runId),
        /scheduler owner-unverifiable/u
    )

    const runMismatch = prepareBoundLayout(t, 'run-mismatch')
    const runLockFile = path.join(
        runMismatch.repositoryRoot,
        '.tmp/test-runs/.locks',
        `${runMismatch.runId}.lock/owner.json`
    )
    const runLockOwner = JSON.parse(fs.readFileSync(runLockFile, 'utf8'))
    runLockOwner.runId = 'other-run'
    fs.writeFileSync(runLockFile, `${JSON.stringify(sealSchedulerRunOwner(runLockOwner))}\n`)
    assert.throws(
        () => productionBuildRunIsActive(runMismatch.repositoryRoot, runMismatch.runId),
        /scheduler owner-unverifiable/u
    )

    const terminalMismatch = prepareBoundLayout(t, 'terminal-mismatch')
    const terminalLockFile = path.join(
        terminalMismatch.repositoryRoot,
        '.tmp/test-runs/.locks',
        `${terminalMismatch.runId}.lock/owner.json`
    )
    const terminalLockOwner = JSON.parse(fs.readFileSync(terminalLockFile, 'utf8'))
    terminalLockOwner.ownerToken = 'replacement-terminal-owner'
    terminalLockOwner.state = 'complete'
    fs.writeFileSync(terminalLockFile, `${JSON.stringify(sealSchedulerRunOwner(terminalLockOwner))}\n`)
    assert.throws(
        () => productionBuildRunIsActive(terminalMismatch.repositoryRoot, terminalMismatch.runId),
        /scheduler owner do not exact-match/u
    )

    const groupMismatch = prepareBoundLayout(t, 'group-mismatch')
    const compiler = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: 'ignore' })
    t.after(() => {
        try {
            process.kill(-compiler.pid, 'SIGKILL')
        } catch {}
    })
    registerProductionBuildCompiler(groupMismatch, collectProcessIdentity(compiler.pid))
    rewriteOwner(groupMismatch, (owner) => ({
        ...owner,
        managedProcessGroupIdentities: owner.managedProcessGroupIdentities.map((group, index) =>
            index === 0 ? { ...group, leaderProcessStartIdentity: `${group.leaderProcessStartIdentity}:reused` } : group
        )
    }))
    assert.throws(
        () => productionBuildRunIsActive(groupMismatch.repositoryRoot, groupMismatch.runId),
        /managed group is unverifiable/u
    )
})

test('exited compiler with expired scheduler owner becomes stale', async (t) => {
    const layout = prepareBoundLayout(t, 'exited-compiler')
    const compiler = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 80)'], { detached: true, stdio: 'ignore' })
    registerProductionBuildCompiler(layout, collectProcessIdentity(compiler.pid))
    await new Promise((resolve) => compiler.once('exit', resolve))
    scanProductionBuildProcesses(layout)
    rewriteOwner(layout, (owner) => {
        const processStartIdentity = `${owner.ownerProcessStartIdentity}:exited`
        return {
            ...owner,
            ownerProcessStartIdentity: processStartIdentity,
            ownerIdentity: { ...owner.ownerIdentity, processStartIdentity },
            schedulerLockIdentity: sealSchedulerRunOwner({
                ...owner.schedulerLockIdentity,
                processStartIdentity
            })
        }
    })
    fs.rmSync(path.join(layout.repositoryRoot, '.tmp/test-runs/.locks', `${layout.runId}.lock`), {
        recursive: true,
        force: true
    })
    assert.equal(productionBuildRunIsActive(layout.repositoryRoot, layout.runId), false)
})

test('GC owner CAS preserves a replacement active root that appears after the stale decision', (t) => {
    const root = fixture(t)
    const runId = 'gc-owner-race'
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
    const stale = prepareProductionBuildLayout({
        root,
        runId,
        sourceState,
        namespace: 'test:stale'
    })
    finalizeProductionBuildLayout(stale, { status: 'failure' })
    let replacement = null
    const report = collectStaleProductionBuildRoots({
        root,
        beforeDelete({ directory }) {
            fs.rmSync(directory, { recursive: true, force: true })
            replacement = prepareProductionBuildLayout({
                root,
                runId,
                sourceState,
                namespace: 'test:replacement'
            })
        }
    })
    assert.deepEqual(report.removed, [])
    assert.deepEqual(report.retained, [runId])
    assert.ok(replacement)
    assert.equal(productionBuildRunIsActive(root, runId), true)
    assert.equal(fs.existsSync(replacement.activeFile), true)
})
