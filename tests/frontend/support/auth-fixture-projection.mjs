const { readPrivateJson } = await import(new URL("../../../tools/test-fixtures/receipt/index.mjs", import.meta.url));

import { resolveAuthFixtureManifest } from './fixture-paths.mjs';
import {
    createAdminStepUpProofToken as createSessionAdminStepUpProofToken
} from './session-fixtures.mjs';

const receiptDigestPattern = /^sha256:[a-f0-9]{64}$/u;

function positiveInteger(value, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
    {
        throw new Error(`auth fixture projection requires a valid ${label}`);
    }
    return parsed;
}

function nonEmptyString(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`auth fixture projection requires a valid ${label}`);
    }
    return normalized;
}

export function readAdminAuthFixtureProjection({
    projectionFile = resolveAuthFixtureManifest()
} = {})
{
    const { document } = readPrivateJson(projectionFile, {
        label: 'auth fixture projection'
    });
    const sourceReceiptDigest = document?.sourceReceiptDigest ?? null;
    if (sourceReceiptDigest != null && !receiptDigestPattern.test(String(sourceReceiptDigest)))
    {
        throw new Error('auth fixture projection sourceReceiptDigest is invalid');
    }

    return Object.freeze({
        adminId: positiveInteger(document?.admin?.id, 'admin id'),
        sessionId: nonEmptyString(document?.admin?.sessionId, 'admin session id'),
        sourceReceiptDigest
    });
}

export function createAdminStepUpProofToken({
    session,
    action = 'admin-sensitive',
    ttlSeconds = 45,
    projectionFile,
    proofProducer = createSessionAdminStepUpProofToken
} = {})
{
    const sessionAdminId = positiveInteger(session?.adminId, 'session admin id');
    const sessionId = nonEmptyString(session?.sessionId, 'session id');
    const projection = readAdminAuthFixtureProjection({ projectionFile });

    if (projection.adminId !== sessionAdminId || projection.sessionId !== sessionId)
    {
        throw new Error('auth fixture projection does not match the active admin session');
    }
    if (typeof proofProducer !== 'function')
    {
        throw new Error('auth fixture projection requires the canonical proof producer');
    }

    return proofProducer({
        adminId: sessionAdminId,
        sessionId,
        action,
        ttlSeconds
    });
}
