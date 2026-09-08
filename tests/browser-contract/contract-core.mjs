export const browserContractScenarios = Object.freeze([
    Object.freeze({
        id: 'public-hydration-history-reload',
        role: 'anonymous',
        capability: 'public-hydration',
        serviceWorkers: 'allow'
    }),
    Object.freeze({
        id: 'account-deep-link-bootstrap',
        role: 'user',
        capability: 'account-session',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'admin-deep-link-expired-session',
        role: 'admin',
        capability: 'admin-session',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'article-publish-persistence',
        role: 'admin',
        capability: 'critical-write',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'webauthn-virtual-authenticator',
        role: 'user',
        capability: 'webauthn',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'service-worker-offline-reload',
        role: 'anonymous',
        capability: 'service-worker',
        serviceWorkers: 'allow'
    })
]);

export function selectBrowserContractScenarios(capabilities = {})
{
    const selected = browserContractScenarios.filter((scenario) => (
        scenario.capability !== 'webauthn' || capabilities.webAuthnRegistration === true
    ));
    contractAssert(selected.length >= 4 && selected.length <= 6, 'browser contract selected scenario count must stay between four and six');
    return Object.freeze(selected);
}

export class BrowserContractFailure extends Error
{
    constructor(message, failureClass = 'contract', details = null)
    {
        super(message);
        this.name = 'BrowserContractFailure';
        this.failureClass = failureClass;
        this.details = details;
    }
}

export function contractAssert(condition, message, details = null)
{
    if (!condition)
    {
        throw new BrowserContractFailure(message, 'contract', details);
    }
}
