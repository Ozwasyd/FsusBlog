/**
 * @typedef {'chromium' | 'firefox' | 'webkit'} BrowserEngine
 * @typedef {'serviceWorker' | 'passkey' | 'conditionalMediation'} BrowserCapability
 * @typedef {'required' | 'optional-with-fallback' | 'intentionally-disabled'} CapabilityClassification
 * @typedef {Readonly<{ classification: CapabilityClassification; supportedBehavior: readonly string[]; fallbackBehavior: readonly string[]; }>} CapabilityDeclaration
 * @typedef {Readonly<Record<BrowserEngine, Readonly<Record<BrowserCapability, CapabilityDeclaration>>>>} BrowserCapabilityContract
 * @typedef {{ probe: boolean; supportedBehavior?: Readonly<Record<string, boolean>>; fallbackBehavior?: Readonly<Record<string, boolean>>; absentCapabilityFixture?: Readonly<Record<string, boolean>>; }} BrowserCapabilityEvidence
 */

const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
const CAPABILITIES = Object.freeze([
    'serviceWorker',
    'passkey',
    'conditionalMediation'
]);
const CLASSIFICATIONS = new Set([
    'required',
    'optional-with-fallback',
    'intentionally-disabled'
]);

/** @type {BrowserCapabilityContract} */
export const browserCapabilityContract = Object.freeze({
    chromium: Object.freeze({
        serviceWorker: declaration('required', [
            'registration-ready',
            'fsus-cache-namespace'
        ]),
        passkey: declaration('optional-with-fallback', [
            'passkey-action-visible',
            'passkey-action-enabled'
        ], [
            'recovery-link-visible',
            'missing-api-not-called'
        ]),
        conditionalMediation: declaration('optional-with-fallback', [
            'conditional-probe-resolved',
            'passkey-action-visible'
        ], [
            'recovery-link-visible',
            'missing-api-not-called'
        ])
    }),
    firefox: Object.freeze({
        serviceWorker: declaration('required', [
            'registration-ready',
            'fsus-cache-namespace'
        ]),
        passkey: declaration('optional-with-fallback', [
            'passkey-action-visible',
            'passkey-action-enabled'
        ], [
            'recovery-link-visible',
            'missing-api-not-called'
        ]),
        conditionalMediation: declaration('optional-with-fallback', [
            'conditional-probe-resolved',
            'passkey-action-visible'
        ], [
            'recovery-link-visible',
            'missing-api-not-called'
        ])
    }),
    webkit: Object.freeze({
        serviceWorker: declaration('intentionally-disabled', [], [
            'policy-disabled',
            'no-registrations',
            'online-shell-usable',
            'no-unhandled-registration-error'
        ]),
        passkey: declaration('optional-with-fallback', [
            'passkey-action-visible',
            'passkey-action-enabled'
        ], [
            'recovery-link-visible',
            'missing-api-not-called'
        ]),
        conditionalMediation: declaration('optional-with-fallback', [
            'conditional-probe-resolved',
            'passkey-action-visible'
        ], [
            'recovery-link-visible',
            'missing-api-not-called'
        ])
    })
});

/**
 * @param {BrowserCapabilityContract} [contract]
 * @returns {BrowserCapabilityContract}
 */
export function validateBrowserCapabilityContract(
    contract = browserCapabilityContract
)
{
    const errors = [];
    const engineNames = Object.keys(contract);

    for (const engine of ENGINES)
    {
        if (!engineNames.includes(engine))
        {
            errors.push(`missing engine declaration: ${engine}`);
            continue;
        }

        const declarations = contract[engine];
        const capabilityNames = Object.keys(declarations);
        for (const capability of CAPABILITIES)
        {
            const entry = declarations[capability];
            if (!entry)
            {
                errors.push(`missing capability declaration: ${engine}/${capability}`);
                continue;
            }
            if (!CLASSIFICATIONS.has(entry.classification))
            {
                errors.push(
                    `invalid classification: ${engine}/${capability}/${entry.classification}`
                );
            }
            if (entry.classification === 'required'
        && entry.supportedBehavior.length === 0)
            {
                errors.push(`required behavior is empty: ${engine}/${capability}`);
            }
            if (entry.classification === 'optional-with-fallback'
        && (entry.supportedBehavior.length === 0
          || entry.fallbackBehavior.length === 0))
            {
                errors.push(
                    `optional capability needs both paths: ${engine}/${capability}`
                );
            }
            if (entry.classification === 'intentionally-disabled'
        && entry.fallbackBehavior.length === 0)
            {
                errors.push(`disabled fallback is empty: ${engine}/${capability}`);
            }
        }

        for (const extra of capabilityNames.filter(
            (capability) => !CAPABILITIES.includes(capability)
        ))
        {
            errors.push(`unknown capability declaration: ${engine}/${extra}`);
        }
    }

    for (const extra of engineNames.filter((engine) => !ENGINES.includes(engine)))
    {
        errors.push(`unknown engine declaration: ${extra}`);
    }

    if (errors.length > 0)
    {
        throw new Error(`browser capability contract is incomplete:\n${errors.join('\n')}`);
    }

    return contract;
}

/**
 * @param {BrowserEngine} browserName
 * @param {BrowserCapability} capability
 * @param {BrowserCapabilityContract} [contract]
 * @returns {CapabilityDeclaration}
 */
export function resolveBrowserCapabilityDeclaration(
    browserName,
    capability,
    contract = browserCapabilityContract
)
{
    validateBrowserCapabilityContract(contract);
    const declaration = contract[browserName]?.[capability];
    if (!declaration)
    {
        throw new Error(
            `browser capability declaration missing: browser=${browserName} capability=${capability}`
        );
    }
    return declaration;
}

/**
 * @param {{ browserName: BrowserEngine; capability: BrowserCapability; evidence: BrowserCapabilityEvidence; contract?: BrowserCapabilityContract; }} options
 * @returns {void}
 */
export function assertBrowserCapabilityBehavior({
    browserName,
    capability,
    evidence,
    contract = browserCapabilityContract
})
{
    const entry = resolveBrowserCapabilityDeclaration(
        browserName,
        capability,
        contract
    );
    const prefix = [
        `browser=${browserName}`,
        `capability=${capability}`,
        `classification=${entry.classification}`,
        `actualProbe=${String(evidence.probe)}`
    ].join(' ');

    if (entry.classification === 'required' && evidence.probe !== true)
    {
        throw new Error(`${prefix} failedStep=required-capability-probe`);
    }
    if (entry.classification === 'intentionally-disabled'
    && evidence.probe !== false)
    {
        throw new Error(`${prefix} failedStep=intentionally-disabled-probe`);
    }

    const actualBehavior = evidence.probe
        ? evidence.supportedBehavior
        : evidence.fallbackBehavior;
    const expectedActualBehavior = evidence.probe
        ? entry.supportedBehavior
        : entry.fallbackBehavior;
    assertBehaviorSteps(prefix, expectedActualBehavior, actualBehavior);

    if (entry.classification === 'optional-with-fallback')
    {
        assertBehaviorSteps(
            `${prefix} fixture=capability-absent`,
            entry.fallbackBehavior,
            evidence.absentCapabilityFixture
        );
    }
}

function declaration(
    classification,
    supportedBehavior,
    fallbackBehavior = []
)
{
    return Object.freeze({
        classification,
        supportedBehavior: Object.freeze([...supportedBehavior]),
        fallbackBehavior: Object.freeze([...fallbackBehavior])
    });
}

function assertBehaviorSteps(prefix, expectedSteps, actualSteps)
{
    for (const step of expectedSteps)
    {
        if (actualSteps?.[step] !== true)
        {
            throw new Error(`${prefix} failedStep=${step}`);
        }
    }
}

