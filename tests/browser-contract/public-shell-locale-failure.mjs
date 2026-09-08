import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const modes = Object.freeze([
    'domain-failure', 'font-failure', 'preference-failure', 'revision-conflict',
    'artifact-invalid', 'superseded-failure', 'retry'
]);

function equal(actual, expected, label)
{
    assert.ok(actual === expected, `failure ${label} mismatch`);
}

function exactKeys(value, allowed, label)
{
    assert.deepEqual(Object.keys(value ?? {}).sort(), [...allowed].sort(), `failure ${label} has an unregistered field`);
}

function rejectSecrets(value)
{
    const text = JSON.stringify(value);
    assert.equal(/\b(?:token|secret|password|authorization)\b/iu.test(text), false, 'failure evidence leaked a secret');
}

/** Inspect a real HTTP/resource injection outcome. Product rollback APIs are not invoked here. */
export function assertPublicShellLocaleFailure({ scene, before, after, injection, logs = [] })
{
    assert.ok(scene.issue === 2087, 'failure requires its matrix scene');
    assert.ok(modes.includes(scene.stage), 'failure requires an injected stage');
    assert.equal(scene.transition?.injectionBoundary, 'http-resource', 'failure must inject at the HTTP/resource boundary');
    exactKeys(before, ['uiLocale', 'selectorActive', 'preference', 'revision', 'businessState', 'fontScript'], 'before');
    exactKeys(after, [
        'uiLocale', 'selectorActive', 'preference', 'revision', 'businessState', 'fontScript',
        'mixedLanguage', 'errorRetryable', 'committed'
    ], 'after');
    exactKeys(injection, ['kind', 'target', 'boundary', 'status', 'artifactIdentity'], 'injection');
    const source = scene.transition.sourceLocale;
    const retry = scene.stage === 'retry';
    equal(injection.boundary, 'http-resource', 'injection boundary');
    equal(injection.kind, scene.transition.failureMode, 'injection kind');
    equal(before.uiLocale, source, 'before ui locale');
    if (retry)
    {
        equal(after.uiLocale, scene.locale, 'retry ui locale');
        equal(after.committed, true, 'retry commit');
        equal(after.preference, scene.locale, 'retry preference');
        assert.ok(after.revision > before.revision, 'retry must use a new revision');
    }
    else
    {
        equal(after.uiLocale, source, 'failed ui locale');
        equal(after.selectorActive, source, 'failed selector active');
        equal(after.preference, source, 'failed preference');
        equal(after.revision, before.revision, 'failed revision');
        equal(after.committed, false, 'failed commit');
        equal(after.mixedLanguage, false, 'failed mixed language');
        equal(after.errorRetryable, true, 'error UI must be retryable');
        equal(after.fontScript, before.fontScript, 'failed font script');
        equal(after.businessState, before.businessState, 'business state reset');
        if (injection.artifactIdentity)
        {
            assert.notEqual(injection.artifactIdentity, scene.locale, 'invalid artifact must not fallback to the target');
        }
    }
    equal(injection.target, scene.locale, 'injection target');
    for (const log of logs)
    {
        exactKeys(log, ['kind', 'target', 'resourceRef', 'preferenceRef', 'revision', 'requestCount'], 'failure log');
        rejectSecrets(log);
    }
    rejectSecrets({ before, after, injection });
    return {
        schema: 'fsusblog.public-shell-locale-failure.v1',
        evidenceKind: 'diagnostic-probe',
        qualificationEligible: false,
        observed: {
            source,
            target: scene.locale,
            mode: scene.transition.failureMode,
            committed: after.committed,
            requestCountDigest: sha256(String(logs.reduce((sum, item) => sum + item.requestCount, 0)))
        }
    };
}
