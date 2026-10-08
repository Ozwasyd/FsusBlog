import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const { canonicalTestId } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));
const { validateCrossStackOwnershipRegistry } = await import(new URL('../../test-matrix/cross-stack-receipts.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const ownershipPath = 'tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json';

/** Encode an existing command assertion identity; neither planned nor replay membership is consulted. */
export function staticAssertionObservation(assertionId, sourceUrl)
{
    const registry = validateCrossStackOwnershipRegistry(JSON.parse(fs.readFileSync(path.join(repositoryRoot, ownershipPath), 'utf8')));
    const binding = registry.assertions.find(entry => entry.id === assertionId
        && ((entry.canonicalOwner === 'cross-stack-static' && entry.kind === 'unique')
            || (entry.canonicalOwner === 'security-static' && entry.kind === 'shared')));
    const file = fileURLToPath(sourceUrl);
    if (!binding || binding.artifactPaths.length !== 1
        || path.resolve(file) !== path.resolve(repositoryRoot, binding.artifactPaths[0])
        || fs.realpathSync(file) !== path.resolve(file) || !fs.statSync(file).isFile())
    {
        throw new Error('static assertion observer requires its original owned source binding');
    }
    return {
        assertionId: binding.id,
        sourceTestId: binding.sourceTestId,
        source: binding.artifactPaths[0],
        coverageIds: binding.coverageIds,
        artifactPaths: binding.artifactPaths,
        framework: 'command',
        canonicalTestId: canonicalTestId({ framework: 'command', source: binding.artifactPaths[0], name: [binding.sourceTestId] })
    };
}

/** The original checker emits its completed terminal decision; this writer observes no other command. */
export function publishStaticAtomicAssertionResult(assertionId, sourceUrl, outcome)
{
    if (!['success', 'failure'].includes(outcome))
    {
        throw new Error('static assertion result requires the original terminal decision');
    }
    const output = process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
    if (output === undefined)
    {
        return null;
    }
    if (!output || !path.isAbsolute(output))
    {
        throw new Error('static assertion result request requires an absolute output path');
    }
    const observation = staticAssertionObservation(assertionId, sourceUrl);
    writeResult(output, observation, outcome === 'failure');
    return observation;
}

function writeResult(file, observation, failed)
{
    const result = {
        schema: 'fsusblog.test-attempt-result.v1',
        failureClass: failed ? 'product' : null,
        failureKind: failed ? 'assertion-mismatch' : null,
        executedTestIds: [observation.canonicalTestId],
        failedTestIds: failed ? [observation.canonicalTestId] : [],
        // These checks read source fixtures and create no product artifacts.
        artifactPaths: []
    };
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(descriptor, `${JSON.stringify(result, null, 4)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

/** Observe exactly one original assertion callback; create its result only when the existing runner requests it. */
export async function observeStaticAtomicAssertion(assertionId, sourceUrl, execute)
{
    if (typeof execute !== 'function')
    {
        throw new Error('static assertion observer requires the original assertion callback');
    }
    const output = process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
    if (output === undefined)
    {
        return await execute();
    }
    if (!output || !path.isAbsolute(output))
    {
        throw new Error('static assertion result request requires an absolute output path');
    }
    const observation = staticAssertionObservation(assertionId, sourceUrl);
    let value;
    try
    {
        value = await execute();
    }
    catch (original)
    {
        try
        {
            writeResult(output, observation, true);
        }
        catch (publicationError)
        {
            // Publication trouble cannot replace the original assertion failure.
            console.error('[static-assertion-result] publication failed:', publicationError);
        }
        throw original;
    }
    writeResult(output, observation, false);
    return value;
}
