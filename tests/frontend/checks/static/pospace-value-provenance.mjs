import { createPoSpaceLexicalProvenance } from './pospace-lexical-provenance.mjs';
import { createPoSpaceStaticValues } from './pospace-static-values.mjs';
import { createPoSpaceWorkerProvenance } from './pospace-worker-provenance.mjs';

export function createPoSpaceValueProvenance(ts)
{
    let staticValues;
    const lexical = createPoSpaceLexicalProvenance(
        ts,
        (...args) => staticValues.resolveStaticMemberValue(...args)
    );
    staticValues = createPoSpaceStaticValues(ts, lexical);
    const provenance = { ...lexical, ...staticValues };
    return { ...provenance, ...createPoSpaceWorkerProvenance(ts, provenance) };
}
