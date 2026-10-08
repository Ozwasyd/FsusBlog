import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

import { assertSameQueryBinding } from './query-case-registry.mjs';
import { sqlFingerprint, summarizeActualPlan } from './query-matrix.mjs';
import { computeSha256 } from './runtime-plan.mjs';

const executeFile = promisify(execFile);

/** Bind the private canonical collector result to the exact HTTP response bytes. */
export function bindQueryPlanCapture({ capture, httpSample, httpSampleIndex, binding })
{
    assertSameQueryBinding(binding, capture?.binding);
    assertSameQueryBinding(binding, httpSample?.binding);
    const observation = capture.observation;
    const body = httpSample.body instanceof ArrayBuffer ? new Uint8Array(httpSample.body) : httpSample.body;
    if (capture.schema !== 'fsusblog.query-plan-capture.v1' || capture.status !== 'collected'
        || !(body instanceof Uint8Array) || !Number.isSafeInteger(httpSampleIndex) || httpSampleIndex < 0
        || !httpSample.requestId || observation?.requestId !== httpSample.requestId
        || observation.method !== 'GET' || observation.path !== httpSample.requestPath
        || observation.status !== 200 || httpSample.status !== 200
        || observation.payloadDigest !== `sha256:${createHash('sha256').update(body).digest('hex')}`
        || observation.databaseAttributionComplete !== true || observation.databaseObservationStatus !== 'complete'
        || observation.databaseDroppedCommandCount !== 0 || observation.databaseLateCommandCount !== 0
        || !Array.isArray(capture.queries) || !capture.queries.length
        || observation.databaseCommandCount !== capture.queries.length
        || observation.databaseFingerprints?.length !== capture.queries.length)
    {
        throw new Error('query plan capture unavailable, incomplete or not bound to the HTTP response');
    }
    const expectedRequestPath = `${httpSample.path}${httpSample.inputCursor
        ? `${httpSample.path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(httpSample.inputCursor)}` : ''}`;
    if (httpSample.requestPath !== expectedRequestPath)
    {
        throw new Error('query plan capture request cursor mismatch');
    }
    return capture.queries.map((query) =>
    {
        if (query.status !== 'collected' || !query.command || !Array.isArray(query.command.parameters)
            || !query.command.databaseContext?.database)
        {
            throw new Error('query statement collector failed');
        }
        summarizeActualPlan(query.explain);
        return {
            status: 'collected', binding, httpSampleIndex,
            sql: query.command.sql, sqlFingerprint: sqlFingerprint(query.command.sql),
            parameters: query.command.parameters, parametersDigest: computeSha256(query.command.parameters),
            databaseContext: query.command.databaseContext, explain: query.explain
        };
    });
}

/** Runtime admission and fixture isolation stay with the existing runtime owner. */
export async function collectQueryPlans({ commandCapturePath, bindingPath, connectionPath, outputPath, collectorPath, httpSample, httpSampleIndex, binding })
{
    const original = fs.readFileSync(commandCapturePath);
    const capturedCommands = JSON.parse(original);
    assertSameQueryBinding(binding, capturedCommands.binding);
    assertSameQueryBinding(binding, JSON.parse(fs.readFileSync(bindingPath, 'utf8')));
    if (capturedCommands.status !== 'captured')
    {
        throw new Error('query command collector failed');
    }
    try
    {
        await executeFile('dotnet', [collectorPath, commandCapturePath, bindingPath, connectionPath, outputPath], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    }
    catch
    {
        throw new Error('query plan collector failed; inspect its private per-statement result');
    }
    if (!original.equals(fs.readFileSync(commandCapturePath)))
    {
        throw new Error('query command observation changed during plan collection');
    }
    const capture = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    if (computeSha256(capturedCommands.commands) !== computeSha256(capture.queries.map((query) => query.command)))
    {
        throw new Error('query plan collector changed the canonical command inventory');
    }
    return bindQueryPlanCapture({ capture, httpSample, httpSampleIndex, binding });
}
