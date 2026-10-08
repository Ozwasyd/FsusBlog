#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { decodeAedsFrame } from './aeds-decoders.mjs';
import { assertSameQueryBinding, buildQueryCaseRegistry, queryCaseIdsForSchema, queryExecutionBlockers, queryMatrixTiers } from './query-case-registry.mjs';
import { mapCanonicalQueryExpectedModel } from './query-expected-model.mjs';
import { evaluateQueryMatrix, validateQueryPolicy } from './query-matrix.mjs';
import { loadQueryPayloadDecoders } from './query-payload-decoders.mjs';
import { collectQueryPlans } from './query-plan-capture.mjs';
import { buildSemanticProofReceipt, verifySemanticProofReceipt } from './semantic-proof.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function failedQueryMatrix(tier, binding, reason, registrySchema)
{
    return {
        schema: 'fsusblog.data-scale-query-matrix-evaluation.v1', tier, binding: binding ?? null,
        ...(registrySchema && !registrySchema.endsWith('.v1') ? { registrySchema } : {}),
        status: 'failed', qualification: 'not-performed', unknownIds: [],
        results: queryCaseIdsForSchema(registrySchema).map((id) => ({ id, status: 'failed', metrics: null, failureReasons: [reason] }))
    };
}

function refuseNativeProducerIntake({ collectorPath, directory, repositoryRoot, binding })
{
    execFileSync('dotnet', [collectorPath, '--producer-intake',
        path.join(directory, 'query-producer-intake.json'), binding.sourceCommit],
    { cwd: repositoryRoot, timeout: 30_000, stdio: 'pipe' });
    // The supplied original Inspect contracts unconditionally forbid execution.
    // A substituted process returning zero cannot admit an expected model here.
    throw new Error('current_original_producer_intake_cannot_authorize_queries');
}

/** Read-only product probe; provisioning and qualification remain original-owner operations. */
export async function runQueryMatrix({ registry, policies, baseUrl, secret, captureDirectory, bindingPath,
    connectionPath, collectorPath, verifyRuntime, fetchImpl = fetch, collect = collectQueryPlans,
    decoders, signal })
{
    const samples = [];
    try
    {
        if (typeof verifyRuntime !== 'function' || !secret || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/u.test(baseUrl))
        {
            throw new Error('dedicated live runtime or authenticated observation unavailable');
        }
        await verifyRuntime();
        const queryCaseIds = queryCaseIdsForSchema(registry.schema);
        if (Object.keys(policies ?? {}).length !== queryCaseIds.length || queryCaseIds.some((id) => !Object.hasOwn(policies, id)))
        {
            throw new Error('complete per-case policies unavailable');
        }
        queryCaseIds.forEach((id) => validateQueryPolicy(policies[id]));
        const payloadDecoders = decoders ?? await loadQueryPayloadDecoders(registry.schema);
        for (const entry of registry.cases)
        {
            const sample = { id: entry.id, binding: registry.binding, status: 'failed', http: [], queries: [] };
            samples.push(sample);
            const blockers = queryExecutionBlockers(entry.id);
            if (blockers.length)
            {
                sample.failureReasons = blockers;
                continue;
            }
            if (entry.status !== 'ready')
            {
                continue;
            }
            try
            {
                const coordinate = entry.coordinate;
                const rows = coordinate.traversalItems ?? coordinate.expectedItems;
                const pageSize = coordinate.pageSize ?? Math.max(1, rows.length);
                const maximumPages = coordinate.traversalItems === undefined ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
                const targetIndex = coordinate.offset === undefined ? 0 : coordinate.offset / pageSize;
                let cursor = null;
                for (let index = 0; index < maximumPages; index += 1)
                {
                    signal?.throwIfAborted();
                    await verifyRuntime();
                    const requestId = `query-${randomUUID()}`;
                    const requestPath = `${coordinate.path}${cursor ? `${coordinate.path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''}`;
                    const started = performance.now();
                    const response = await fetchImpl(`${baseUrl}${requestPath}`, {
                        headers: { Accept: 'application/octet-stream', 'X-Fsus-Runtime-Evidence-Request': requestId, 'X-Fsus-Runtime-Evidence-Secret': secret },
                        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
                    });
                    const body = new Uint8Array(await response.arrayBuffer());
                    const httpSample = { binding: registry.binding, path: coordinate.path, requestPath, requestId,
                        inputCursor: cursor, status: response.status, contentType: response.headers.get('content-type'),
                        body, latencyMs: performance.now() - started };
                    sample.http.push(httpSample);
                    if (response.status !== 200)
                    {
                        throw new Error('product HTTP case failed');
                    }
                    const decoded = payloadDecoders[entry.id](decodeAedsFrame(body).payload);
                    // Follow only the actual product cursor. Exactness is checked over the complete traversal.
                    if (index === targetIndex)
                    {
                        const captureName = `${createHash('sha256').update(requestId).digest('hex')}.json`;
                        sample.queries = await collect({ commandCapturePath: path.join(captureDirectory, captureName),
                            bindingPath, connectionPath, collectorPath, outputPath: path.join(captureDirectory, `${requestId}.plans.json`),
                            httpSample, httpSampleIndex: index, binding: registry.binding });
                    }
                    cursor = coordinate.traversalItems === undefined ? null : decoded.nextCursor;
                    if (!cursor)
                    {
                        break;
                    }
                }
                await verifyRuntime();
                sample.status = 'collected';
            }
            catch
            {
                sample.failureReasons = ['product HTTP, cursor, runtime or query collector failed'];
            }
        }
        const matrix = evaluateQueryMatrix({ registry, samples, policies, decoders: payloadDecoders });
        return { ...matrix, qualification: 'not-performed' };
    }
    catch
    {
        return failedQueryMatrix(registry.tier, registry.binding, 'query runner prerequisites or runtime unavailable', registry.schema);
    }
}

export async function runQueryMatrixFiles({ tier, directory, repositoryRoot = root,
    collectorPath = path.join(repositoryRoot, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll') })
{
    let binding;
    let registrySchema;
    try
    {
        const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        binding = read('query-binding.json');
        if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim() !== binding.sourceCommit
            || execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repositoryRoot, encoding: 'utf8' }).trim())
        {
            throw new Error('query runner requires the exact clean source commit');
        }
        const input = read('query-expected-input.json');
        registrySchema = input.registrySchema;
        // The actual native intake precedes expected mapping and every HTTP/capture.
        // It consumes no caller scalar map or verified flag as producer authority.
        refuseNativeProducerIntake({ collectorPath, directory, repositoryRoot, binding });
        const model = mapCanonicalQueryExpectedModel({ ...input, binding });
        if (model.tier !== tier)
        {
            throw new Error('query tier mismatch');
        }
        const runtime = process.env.FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH
            ? JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, process.env.FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH), 'utf8'))
            : read('runtime-receipt.json');
        const { contentDigest, verifyDataScaleRuntimeLiveness } = await import(new URL('../test/data-scale-runtime-owner.mjs', import.meta.url));
        const { contentDigest: recordedDigest, ...runtimeBody } = runtime;
        if (recordedDigest !== contentDigest(runtimeBody) || runtime.schema !== 'fsusblog.data-scale-runtime.v2'
            || runtime.sourceCommit !== binding.sourceCommit || runtime.dataScaleRunId !== binding.dataScaleRunId
            || fs.realpathSync(directory) !== fs.realpathSync(path.resolve(repositoryRoot, runtime.dataRoot)))
        {
            throw new Error('current canonical runtime receipt missing or mismatched');
        }
        assertSameQueryBinding(binding, read('query-capture-binding.json'));
        for (const name of ['query-observation.secret', 'query-connection.secret'])
        {
            const privatePath = path.join(directory, name);
            const stat = fs.lstatSync(privatePath);
            if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
            {
                throw new Error('query connection and observation material must be private regular files');
            }
        }
        return await runQueryMatrix({ registry: buildQueryCaseRegistry({ ...model, binding }), policies: read('query-policy.json'),
            baseUrl: runtime.backend.baseUrl, secret: fs.readFileSync(path.join(directory, 'query-observation.secret'), 'utf8').trim(),
            captureDirectory: path.join(directory, 'query-captures'), bindingPath: path.join(directory, 'query-capture-binding.json'),
            connectionPath: path.join(directory, 'query-connection.secret'),
            collectorPath,
            verifyRuntime: () => verifyDataScaleRuntimeLiveness({ repositoryRoot, runtimeReceipt: runtime }) });
    }
    catch
    {
        return failedQueryMatrix(tier, binding, 'canonical model, policy, private capture or current runtime inputs unavailable', registrySchema);
    }
}

export function writeQueryMatrix(file, matrix)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    const tier = args[args.indexOf('--tier') + 1];
    if (!queryMatrixTiers.includes(tier) || ![2, 4].includes(args.length) || args[0] !== '--tier'
        || (args.length === 4 && args[2] !== '--summary'))
    {
        console.error('usage: run-query-matrix.mjs --tier scale-xs|scale-s|scale-m [--summary <semantic-summary>]');
        process.exitCode = 2;
    }
    else
    {
        const directory = process.env.FSUSBLOG_DATA_SCALE_OUT_DIR ?? path.join(process.env.FSUSBLOG_DATA_SCALE_ROOT ?? path.join(root, '.tmp/scale'), tier);
        const summaryFile = args.length === 4 ? path.resolve(args[3]) : null;
        let semantic;
        if (summaryFile)
        {
            try
            {
                semantic = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
            }
            catch
            {
                semantic = null;
            }
        }
        const matrix = summaryFile && (!verifySemanticProofReceipt(semantic).ok || semantic.tier !== tier)
            ? failedQueryMatrix(tier, null, 'current semantic prerequisite failed or unavailable')
            : await runQueryMatrixFiles({ tier, directory });
        writeQueryMatrix(path.join(directory, 'query-matrix.json'), matrix);
        if (semantic)
        {
            semantic.queryMatrix = matrix;
            if (matrix.status !== 'ok')
            {
                semantic.status = 'failed';
                semantic.failureReasons = [...(semantic.failureReasons ?? []), 'data-scale query matrix failed'];
            }
            // Rebuild through the original semantic receipt producer. Keep its original scheduler binding outside its digest.
            const { releaseReliability, ...semanticBody } = semantic;
            const updated = buildSemanticProofReceipt(semanticBody);
            writeQueryMatrix(summaryFile, releaseReliability ? { ...updated, releaseReliability } : updated);
        }
        console.log(JSON.stringify({ tier, status: matrix.status, qualification: matrix.qualification }));
        process.exitCode = matrix.status === 'ok' ? 0 : 1;
    }
}
