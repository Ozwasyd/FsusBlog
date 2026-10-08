import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { commandWrapperCallerOwnerPaths } from './command-wrapper-caller-binding.mjs';
import { observeUnpromotedMetadataCompileBinding } from './command-wrapper-compile-probe-v2.mjs';

const { observeExecutableIdentity } = await import(new URL('../test/execution-envelope-environment.mjs', import.meta.url));
const { inspectReleaseFinalCommandTarget } = await import(new URL('../test-matrix/release-final-static-boundary.mjs', import.meta.url));

const target = 'tools/test/run-deterministic-command.mjs';
const sourceIndex = 'config/testing/release-final-execution-authority-index.json';

function exactOptions(options, keys)
{
    assert.ok(options && Object.getPrototypeOf(options) === Object.prototype, 'plain caller options required');
    assert.equal(Object.getOwnPropertySymbols(options).length, 0, 'caller option symbols refused');
    assert.deepEqual(Object.getOwnPropertyNames(options).sort(), [...keys].sort(), 'caller probe options widened');
    assert.ok(Object.values(Object.getOwnPropertyDescriptors(options)).every(descriptor =>
        Object.hasOwn(descriptor, 'value') && descriptor.enumerable), 'caller option accessors or hidden fields refused');
}

/** Complete current finite source inspection; observation is never caller admission. */
export function observeUnpromotedCurrentCallerClosure(options)
{
    exactOptions(options, ['root']);
    const { root } = options;
    assert.ok(typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) === root,
        'caller probe requires an absolute physical root');
    assert.equal(fs.realpathSync(root), root, 'caller probe root redirected');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const parserRuntime = observeExecutableIdentity(process.execPath);
    const context = {
        repositoryRoot: root,
        target,
        // Keep every original policy, runtime and native anchor while discovering
        // the current transitive imports through the existing finite source owner.
        additionalTargets: [...commandWrapperCallerOwnerPaths.filter(file => file !== target), sourceIndex]
    };
    const inspection = inspectReleaseFinalCommandTarget(context);
    assert.deepEqual(inspection.errors, [], 'current finite caller source inspection refused');
    const files = [
        { path: target, contentDigest: inspection.contentDigest, indexDigest: inspection.indexDigest },
        ...inspection.dependencyClosure
    ].sort((left, right) => left.path.localeCompare(right.path));
    const paths = new Set(files.map(file => file.path));
    assert.equal(paths.size, files.length, 'duplicate current caller dependency');
    assert.ok(commandWrapperCallerOwnerPaths.every(file => paths.has(file)), 'original caller anchor omitted');
    assert.ok(paths.has(sourceIndex), 'current finite source declaration omitted');
    for (const file of files)
    {
        assert.match(file.contentDigest, /^sha256:[a-f0-9]{64}$/u, 'caller file identity unavailable');
        assert.equal(file.contentDigest, file.indexDigest, 'caller source differs from actual index');
    }
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), commit,
        'caller candidate changed during inspection');
    // These are source observations for independent semantic review. No fresh
    // hash is inserted into the frozen v1 registry, and no declared policy is
    // inferred approved merely because the inspector could follow its imports.
    const proposal = {
        schema: 'fsusblog.command-wrapper-current-caller-probe.v2',
        sourceCommit: commit,
        parserRuntime,
        target,
        originalAnchorCount: commandWrapperCallerOwnerPaths.length,
        files,
        ownedInputClasses: ['main.argc', 'main.argv'],
        callerInputAdmission: false,
        semanticReviewRequired: true,
        qualificationEligible: false,
        policyPromotion: false,
        analyzerOptions: []
    };
    const revalidate = () =>
    {
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), commit,
            'caller candidate changed after inspection');
        assert.deepEqual(observeExecutableIdentity(process.execPath), parserRuntime, 'caller parser runtime drift');
        assert.deepEqual(inspectReleaseFinalCommandTarget(context), inspection, 'current caller closure changed after inspection');
    };
    revalidate();
    return { proposal: structuredClone(proposal), revalidate };
}

/** Join actual source observations without creating or selecting trusted authority. */
export function observeUnpromotedCurrentCommandProfile(options)
{
    exactOptions(options, ['entry', 'environment', 'file', 'policy', 'root']);
    const compiled = observeUnpromotedMetadataCompileBinding(options);
    const caller = observeUnpromotedCurrentCallerClosure({ root: options.root });
    const source = caller.proposal.files.find(file => file.path === options.file);
    assert.ok(source, 'compiled TU absent from current caller closure');
    assert.equal(source.contentDigest, `sha256:${compiled.binding.source.sha256}`, 'caller and compiler TU identity mismatch');
    const revalidate = () =>
    {
        caller.revalidate();
        compiled.revalidate();
        caller.revalidate();
    };
    revalidate();
    return {
        proposal: structuredClone({
            schema: 'fsusblog.command-wrapper-current-source-profile.v2',
            sourceCommit: caller.proposal.sourceCommit,
            caller: caller.proposal,
            compile: compiled.binding,
            independentProfileReviewRequired: true,
            callerInputAdmission: false,
            qualificationEligible: false,
            policyPromotion: false,
            analyzerOptions: []
        }),
        revalidate
    };
}
