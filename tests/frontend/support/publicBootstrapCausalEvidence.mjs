/**
 * Long-lived public bootstrap causal evidence contract.
 *
 * Schema name is stable and must not carry issue-number prefixes.
 * Correctness gates use causal order, not absolute millisecond budgets.
 */

export const PUBLIC_BOOTSTRAP_CAUSAL_EVIDENCE_SCHEMA = 'fsusblog.public-bootstrap-causal-evidence.v1';

/**
 * @typedef {Readonly<{
 *   schema: typeof PUBLIC_BOOTSTRAP_CAUSAL_EVIDENCE_SCHEMA
 *   buildIdentity: string | null
 *   route: string
 *   scenario: string
 *   timestamps: Readonly<{
 *     intent: number | null
 *     entryStart: number | null
 *     entryEnd: number | null
 *     coreStart: number | null
 *     coreEnd: number | null
 *     componentStart: number | null
 *     componentEnd: number | null
 *     snapshotStart: number | null
 *     snapshotEnd: number | null
 *     feedbackFirstVisible: number | null
 *     feedbackHidden: number | null
 *     commitStart: number | null
 *     interactive: number | null
 *     fallback: number | null
 *   }>
 *   navigationCount: number
 *   documentNavigationCount: number
 *   listenerFinalCount: number | null
 *   overlayFinalCount: number | null
 *   notes?: readonly string[]
 * }>} PublicBootstrapCausalEvidence
 */

// The collector owns this fresh mutable record; causal validators accept its readonly view.
/**
 * @typedef {{
 *   schema: typeof PUBLIC_BOOTSTRAP_CAUSAL_EVIDENCE_SCHEMA
 *   buildIdentity: string | null
 *   route: string
 *   scenario: string
 *   timestamps: {
 *     intent: number | null
 *     entryStart: number | null
 *     entryEnd: number | null
 *     coreStart: number | null
 *     coreEnd: number | null
 *     componentStart: number | null
 *     componentEnd: number | null
 *     snapshotStart: number | null
 *     snapshotEnd: number | null
 *     feedbackFirstVisible: number | null
 *     feedbackHidden: number | null
 *     commitStart: number | null
 *     interactive: number | null
 *     fallback: number | null
 *   }
 *   navigationCount: number
 *   documentNavigationCount: number
 *   listenerFinalCount: number | null
 *   overlayFinalCount: number | null
 *   notes?: readonly string[]
 * }} MutablePublicBootstrapCausalEvidence
 */

/**
 * @param {Partial<PublicBootstrapCausalEvidence> & Pick<PublicBootstrapCausalEvidence, 'route' | 'scenario'>} partial
 * @returns {MutablePublicBootstrapCausalEvidence}
 */
export function createEmptyPublicBootstrapCausalEvidence(partial)
{
    return {
        schema: PUBLIC_BOOTSTRAP_CAUSAL_EVIDENCE_SCHEMA,
        buildIdentity: partial.buildIdentity ?? null,
        route: partial.route,
        scenario: partial.scenario,
        timestamps: {
            intent: null,
            entryStart: null,
            entryEnd: null,
            coreStart: null,
            coreEnd: null,
            componentStart: null,
            componentEnd: null,
            snapshotStart: null,
            snapshotEnd: null,
            feedbackFirstVisible: null,
            feedbackHidden: null,
            commitStart: null,
            interactive: null,
            fallback: null,
            ...(partial.timestamps ?? {})
        },
        navigationCount: partial.navigationCount ?? 0,
        documentNavigationCount: partial.documentNavigationCount ?? 0,
        listenerFinalCount: partial.listenerFinalCount ?? null,
        overlayFinalCount: partial.overlayFinalCount ?? null,
        notes: partial.notes ?? []
    };
}

/**
 * Fixed causal assertions from the public bootstrap contract.
 * Absolute ms budgets are never used as the sole correctness oracle.
 *
 * @param {PublicBootstrapCausalEvidence} evidence
 * @returns {string[]} violation messages (empty when causal order holds)
 */
export function assertPublicBootstrapCausalOrder(evidence)
{
    const t = evidence.timestamps;
    /** @type {string[]} */
    const violations = [];
    const phase = (label) => `[${evidence.scenario}@${evidence.route}] ${label}`;

    const defined = (value) => typeof value === 'number' && Number.isFinite(value);

    if (defined(t.intent) && defined(t.entryStart) && t.intent > t.entryStart)
    {
        violations.push(phase(`intent (${t.intent}) must be <= entryStart (${t.entryStart})`));
    }
    if (defined(t.intent) && defined(t.coreStart) && t.intent > t.coreStart)
    {
        violations.push(phase(`intent (${t.intent}) must be <= coreStart (${t.coreStart})`));
    }
    if (defined(t.intent) && defined(t.componentStart) && t.intent > t.componentStart)
    {
        violations.push(phase(`intent (${t.intent}) must be <= componentStart (${t.componentStart})`));
    }
    if (defined(t.intent) && defined(t.snapshotStart) && t.intent > t.snapshotStart)
    {
        violations.push(phase(`intent (${t.intent}) must be <= snapshotStart (${t.snapshotStart})`));
    }

    // feedback visible only when it crossed a frame; then intent < feedback visible
    if (defined(t.intent) && defined(t.feedbackFirstVisible) && !(t.intent < t.feedbackFirstVisible))
    {
        violations.push(phase(
            `intent (${t.intent}) must be < feedbackFirstVisible (${t.feedbackFirstVisible}) when feedback crossed a frame`
        ));
    }

    if (defined(t.feedbackFirstVisible) && defined(t.interactive) && !(t.feedbackFirstVisible < t.interactive))
    {
        violations.push(phase(
            `feedbackFirstVisible (${t.feedbackFirstVisible}) must be < interactive (${t.interactive}) when feedback was shown`
        ));
    }

    // Snapshot producers may start before commit (intent prepare). Enforce only that
    // commit precedes interactive when both are recorded.
    if (defined(t.commitStart) && defined(t.interactive) && t.commitStart > t.interactive)
    {
        violations.push(phase(`commitStart (${t.commitStart}) must be <= interactive (${t.interactive})`));
    }

    if (defined(t.interactive) && defined(t.feedbackHidden) && t.interactive > t.feedbackHidden)
    {
        violations.push(phase(
            `interactive (${t.interactive}) must be <= feedbackHidden (${t.feedbackHidden}) when feedback was shown`
        ));
    }

    if (defined(t.interactive) && defined(t.fallback))
    {
        violations.push(phase('interactive and fallback must not both be terminal for one evidence record'));
    }

    if (defined(t.feedbackFirstVisible) && defined(t.interactive) && defined(t.feedbackHidden))
    {
        if (t.feedbackFirstVisible > t.interactive)
        {
            violations.push(phase('late-visible feedback after interactive is forbidden'));
        }
    }

    return violations;
}

/**
 * @param {PublicBootstrapCausalEvidence} evidence
 * @param {string} [context]
 * @returns {void}
 */
export function requirePublicBootstrapCausalOrder(evidence, context = 'public-bootstrap-causal')
{
    if (evidence.schema !== PUBLIC_BOOTSTRAP_CAUSAL_EVIDENCE_SCHEMA)
    {
        throw new Error(`${context}: unexpected evidence schema ${evidence.schema}`);
    }
    const violations = assertPublicBootstrapCausalOrder(evidence);
    if (violations.length > 0)
    {
        throw new Error(`${context} causal order failed:\n${violations.join('\n')}`);
    }
}
