type BrowserIdentityModule = typeof import('../../../tools/test/playwright-browser-identity.mjs');
type LiveBrowserPlan = import('../../../tools/test/playwright-browser-identity.mjs').CorrectnessBrowserPlan;
type SerializedBrowserPlan = import('../../../tools/test/playwright-browser-identity.mjs').SerializableBrowserPlan;
type BrowserIdentityPolicy = import('../../../tools/test/playwright-browser-identity.mjs').PlaywrightBrowserIdentityPolicy;
type RandomIdentityModule = typeof import('../../../tools/test/random-streams.mjs');
type RandomStreamReceipt = import('../../../tools/test/random-streams.mjs').RandomStreamReceipt;
type RandomExecutionObservation = import('../../../tools/test/random-streams.mjs').RandomExecutionObservation;
type CanonicalReceiptModule = typeof import('../../../tools/test-fixtures/receipt/canonical.mjs');
type PublicFixturesModule = typeof import('../support/public-fixtures.mjs');

export function checkBrowserPlanValidatorContract(identity: BrowserIdentityModule, livePlan: LiveBrowserPlan, frontendRoot: string)
{
    const serialized = identity.serializableBrowserPlan(livePlan);
    const validated = identity.validateBrowserIdentityPlan(serialized);
    const portable: SerializedBrowserPlan = validated;
    const verification = identity.verifyCorrectnessBrowserPlans({ plans: [portable], frontendRoot });
    void verification;

    // Validation checks portable identity fields; it does not reconstruct a BrowserType.
    // @ts-expect-error serialized validation cannot promise a live browser launcher
    validated.browserType.launch();
    // @ts-expect-error portable validation cannot promote a serialized plan to a live plan
    const promoted: LiveBrowserPlan = validated;
    void promoted;

    const wireValue: unknown = JSON.parse(JSON.stringify(serialized));
    const checkedWire = identity.validateBrowserIdentityPlan(wireValue);
    // Identity validation does not establish every portable launch member.
    // @ts-expect-error unknown input cannot promise a complete portable plan
    const uncheckedPortable: SerializedBrowserPlan = checkedWire;
    void uncheckedPortable;
    // @ts-expect-error unknown input cannot promise launch options
    checkedWire.launchOptions.args;

    // The factory's original live plan retains its actual browser capability.
    const launcher: LiveBrowserPlan['browserType'] = livePlan.browserType;
    return { portable, launcher };
}

export function checkOpaqueIdentityValidationContracts(
    identity: BrowserIdentityModule,
    random: RandomIdentityModule,
    policy: BrowserIdentityPolicy,
    receipt: RandomStreamReceipt,
    observation: RandomExecutionObservation,
    context: Parameters<RandomIdentityModule['validateRandomStreamReceipt']>[1],
    wireValue: unknown
)
{
    const knownPolicy: BrowserIdentityPolicy = identity.validatePlaywrightBrowserIdentityPolicy(policy);
    const knownReceipt: RandomStreamReceipt = random.validateRandomStreamReceipt(receipt, context);
    const knownObservation: RandomExecutionObservation = random.validateRandomExecutionObservation(observation, {
        ...context,
        runId: observation.runId,
        attemptId: observation.attemptId,
        planDigest: observation.replayPlanDigest
    });
    const checkedPolicy = identity.validatePlaywrightBrowserIdentityPolicy(wireValue);
    const checkedReceipt = random.validateRandomStreamReceipt(wireValue, context);
    // @ts-expect-error policy validation does not prove nested string elements
    checkedPolicy.correctness.launch.chromium.args[0].trim();
    // @ts-expect-error receipt validation does not prove the budget exists
    checkedReceipt.budget.iterations;
    const checkedObservation = random.validateRandomExecutionObservation(wireValue, {
        ...context,
        runId: observation.runId,
        attemptId: observation.attemptId,
        planDigest: observation.replayPlanDigest
    });
    // @ts-expect-error direct observation checks can coerce nonstring digest values
    checkedObservation.caseIdentities[0].startsWith('sha256:');
    return { knownPolicy, knownReceipt, knownObservation };
}

export function checkOpaqueProjectionContracts(
    canonical: CanonicalReceiptModule,
    fixtures: PublicFixturesModule,
    random: RandomIdentityModule,
    readOptions: Parameters<RandomIdentityModule['readRandomExecutionObservation']>[0]
)
{
    const projection = fixtures.readPublicFixtures();
    const articleId: number = projection.articleId;
    const articleTitle: string = projection.articleTitle;
    // @ts-expect-error normalized IDs do not prove the passthrough source metadata
    projection.sourceIdentity?.commit?.trim();
    // @ts-expect-error normalized IDs do not prove passthrough array metadata
    projection.idsByKind?.unused?.map(String);
    // @ts-expect-error enumerable-key projection does not retain Date methods
    canonical.freezeDeep(new Date(0)).getTime();
    // @ts-expect-error enumerable-key projection does not retain Map methods
    canonical.freezeDeep(new Map<string, number>()).get('value');
    const observed = random.readRandomExecutionObservation(readOptions);
    const observedCount: number = observed.caseIdentities.length;
    // @ts-expect-error a JSON array digest can pass coercive validation without becoming a string
    observed.caseIdentities[0].startsWith('sha256:');
    return { articleId, articleTitle, observedCount };
}
