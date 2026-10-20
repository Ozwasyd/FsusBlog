type BrowserIdentityModule = typeof import('../../../tools/test/playwright-browser-identity.mjs');
type LiveBrowserPlan = import('../../../tools/test/playwright-browser-identity.mjs').CorrectnessBrowserPlan;
type SerializedBrowserPlan = import('../../../tools/test/playwright-browser-identity.mjs').SerializableBrowserPlan;

export function checkBrowserPlanValidatorContract(identity: BrowserIdentityModule, livePlan: LiveBrowserPlan, frontendRoot: string)
{
    const serialized = identity.serializableBrowserPlan(livePlan);
    const validated = identity.validateBrowserIdentityPlan(JSON.parse(JSON.stringify(serialized)));
    const portable: SerializedBrowserPlan = validated;
    const verification = identity.verifyCorrectnessBrowserPlans({ plans: [portable], frontendRoot });
    void verification;

    // Validation checks portable identity fields; it does not reconstruct a BrowserType.
    // @ts-expect-error serialized validation cannot promise a live browser launcher
    validated.browserType.launch();
    // @ts-expect-error portable validation cannot promote a serialized plan to a live plan
    const promoted: LiveBrowserPlan = validated;
    void promoted;

    // The factory's original live plan retains its actual browser capability.
    const launcher: LiveBrowserPlan['browserType'] = livePlan.browserType;
    return { portable, launcher };
}
