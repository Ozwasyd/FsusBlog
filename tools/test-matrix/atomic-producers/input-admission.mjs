import path from 'node:path';
import { URL } from 'node:url';

import { resolveAtomicReference } from './contract.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateCorrectnessInputManifest } = await import(new URL('../correctness-input-manifest.mjs', import.meta.url));

/** Consume the original bounded manifest; never generate an input authority or read trace. */
export function createAtomicCorrectnessInputAdmission({ root, inputClosure, manifest })
{
    if (typeof root !== 'string' || !path.isAbsolute(root))
    {
        throw new Error('atomic manifest admission requires an absolute repository root');
    }
    const closure = structuredClone(inputClosure);
    const inputClosureRef = Object.freeze({ id: closure.id, contentDigest: closure.contentDigest });
    resolveAtomicReference([closure], inputClosureRef, 'input closure');
    const snapshot = structuredClone(manifest);
    validateCorrectnessInputManifest(snapshot);
    if (closure.inputManifestDigest !== snapshot.closureDigest
        || !Array.isArray(closure.unresolvedDynamicReads) || closure.unresolvedDynamicReads.length !== 0)
    {
        throw new Error('atomic input closure must bind the original resolved manifest digest');
    }
    return Object.freeze({
        inputClosureRef,
        validate: ({ inputClosureRef: currentRef, commandSourceRef, command }) =>
        {
            if (digestCanonical(currentRef) !== digestCanonical(inputClosureRef)
                || commandSourceRef?.id !== closure.commandSourceId
                || digestCanonical(command) !== closure.commandDigest)
            {
                throw new Error('atomic manifest admission differs from the compiled command or input closure');
            }
            // The upstream bounded command representation splits on whitespace.
            // Refuse argv needing shell quoting rather than invent another parser.
            if (!Array.isArray(command) || command.length === 0
                || command.some((argument) => typeof argument !== 'string' || !/^[A-Za-z0-9._/:=+-]+$/u.test(argument)))
            {
                throw new Error('atomic manifest admission requires an unquoted bounded argv');
            }
            validateCorrectnessInputManifest(snapshot, { root, entryCommand: command.join(' ') });
        }
    });
}
