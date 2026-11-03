const { digestCanonical } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));

// Controlled expectations exercise the host contract; they are not producer receipts.
export function heldBuildOutcomeInputs({ identity, inputAuthorityRefs, attemptEligibility, plan, evidence })
{
    const held = structuredClone({
        identity,
        inputAuthorityRefs,
        attemptEligibility,
        planDigest: digestCanonical(plan),
        evidenceDigest: digestCanonical(evidence),
        verified: true
    });
    return () => structuredClone(held);
}
