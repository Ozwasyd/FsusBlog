import { computed, shallowRef } from 'vue';

import type {
    ArticleTemplateCreateHost,
    ArticleTemplateInputs,
    ArticleTemplatePlan,
    ArticleTemplateSummary,
    ArticleTemplateTransport,
    ArticleTemplateVersion,
    ArticleTemplateVersionReference,
    CanonicalArticleCreateReceipt,
    CanonicalArticleCreateRequest
} from '@/api/articleTemplates';

type PickerPhase = 'closed' | 'loading' | 'choosing' | 'preview' | 'planning' | 'ready' | 'create-retry' | 'creating' | 'created' | 'open-failed' | 'error';

class ArticleTemplateInteractionError extends Error
{
    readonly code: string;

    constructor(code: string)
    {
        super(code);
        this.code = code;
    }
}

/** Owns only one explicit interaction, never preferences, template truth, expansion or draft state. */
export function useArticleTemplatePicker(
    transport: ArticleTemplateTransport,
    host: ArticleTemplateCreateHost,
    options: { readonly newRequestId: () => string; readonly now: () => number; }
)
{
    const phase = shallowRef<PickerPhase>('closed');
    const items = shallowRef<readonly ArticleTemplateSummary[]>([]);
    const nextCursor = shallowRef<string | null>(null);
    const version = shallowRef<ArticleTemplateVersion | null>(null);
    const versionChoices = shallowRef<readonly ArticleTemplateVersionReference[]>([]);
    const nextVersionNumber = shallowRef<number | null>(null);
    const plan = shallowRef<ArticleTemplatePlan | null>(null);
    const receipt = shallowRef<CanonicalArticleCreateReceipt | null>(null);
    const blankOpenObligation = shallowRef<CanonicalArticleCreateReceipt | null>(null);
    const blankReason = shallowRef<string | null>(null);
    const reason = shallowRef<string | null>(null);
    let generation = 0;
    let request: CanonicalArticleCreateRequest | null = null;
    let activeRead: AbortController | null = null;
    let versionRead: AbortController | null = null;
    let blankRequest: Extract<CanonicalArticleCreateRequest, { kind: 'blank'; }> | null = null;
    let blankInFlight: Promise<CanonicalArticleCreateReceipt> | null = null;
    let blankUncertain = false;
    const canCreate = computed(() => (phase.value === 'ready' || phase.value === 'create-retry') && plan.value !== null);
    const visible = computed(() => phase.value !== 'closed');

    function invalidate(): number
    {
        activeRead?.abort();
        versionRead?.abort();
        activeRead = null;
        generation += 1;
        version.value = null;
        plan.value = null;
        request = null;
        reason.value = null;
        return generation;
    }

    function fail(error: unknown): void
    {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        reason.value = typeof code === 'string' && /^[a-z][a-z0-9_:.]{0,127}$/u.test(code)
            ? code : 'article_template_request_failed';
        plan.value = null;
        phase.value = 'error';
    }

    async function search(query = '', cursor: string | null = null): Promise<void>
    {
        if (phase.value === 'creating' || phase.value === 'create-retry' || phase.value === 'open-failed')
        {
            return;
        }
        const current = invalidate();
        receipt.value = null;
        versionChoices.value = [];
        nextVersionNumber.value = null;
        activeRead = new AbortController();
        phase.value = 'loading';
        items.value = [];
        try
        {
            const page = await transport.list({ query, cursor, limit: 50 }, activeRead.signal);
            if (current !== generation)
            {
                return;
            }
            if (page.items.length > 50 || page.items.some(item => item.status !== 'active'))
            {
                throw new ArticleTemplateInteractionError('article_template_list_binding_invalid');
            }
            items.value = Object.freeze(page.items.map(item => Object.freeze({ ...item })));
            nextCursor.value = page.nextCursor;
            phase.value = 'choosing';
        }
        catch (error)
        {
            if (current === generation)
            {
                fail(error);
            }
        }
    }

    async function select(selected: ArticleTemplateSummary): Promise<void>
    {
        if (phase.value === 'creating' || phase.value === 'create-retry' || phase.value === 'open-failed' || !items.value.includes(selected))
        {
            return;
        }
        versionChoices.value = [];
        nextVersionNumber.value = null;
        await readVersion(selected);
    }

    async function readVersion(selected: ArticleTemplateSummary): Promise<void>
    {
        const current = invalidate();
        activeRead = new AbortController();
        phase.value = 'loading';
        try
        {
            const result = await transport.getVersion({ templateId: selected.templateId, versionId: selected.versionId }, activeRead.signal);
            if (current !== generation)
            {
                return;
            }
            if (result.status !== 'active' || result.templateId !== selected.templateId || result.versionId !== selected.versionId
                || result.versionNumber !== selected.versionNumber || result.versionDigest !== selected.versionDigest
                || result.definitionRevision !== selected.definitionRevision)
            {
                throw new ArticleTemplateInteractionError('article_template_selection_stale');
            }
            version.value = freezeVersion(result);
            phase.value = 'preview';
        }
        catch (error)
        {
            if (current === generation)
            {
                fail(error);
            }
        }
    }

    async function loadVersions(afterVersionNumber: number | null = null): Promise<void>
    {
        if (!version.value || !['preview', 'ready'].includes(phase.value))
        {
            return;
        }
        const current = generation;
        const selected = version.value;
        versionRead?.abort();
        const read = new AbortController();
        versionRead = read;
        try
        {
            const page = await transport.listVersions({ templateId: selected.templateId, afterVersionNumber, limit: 50 }, read.signal);
            if (current !== generation || versionRead !== read)
            {
                return;
            }
            if (page.items.length > 50 || new Set(page.items.map(item => item.versionId)).size !== page.items.length
                || page.items.some(item => !Number.isInteger(item.versionNumber) || item.versionNumber < 1
                    || !/^[a-f0-9]{64}$/u.test(item.versionDigest)))
            {
                throw new ArticleTemplateInteractionError('article_template_version_page_invalid');
            }
            versionChoices.value = Object.freeze(page.items.map(item => Object.freeze({ ...item })));
            nextVersionNumber.value = page.nextVersionNumber;
        }
        catch (error)
        {
            if (current === generation && versionRead === read)
            {
                fail(error);
            }
        }
    }

    async function selectVersion(selected: ArticleTemplateVersionReference): Promise<void>
    {
        if (!version.value || !versionChoices.value.includes(selected) || !['preview', 'ready'].includes(phase.value))
        {
            return;
        }
        await readVersion({ ...version.value, ...selected });
    }

    function editInputs(): void
    {
        if (phase.value === 'creating' || phase.value === 'create-retry' || phase.value === 'created' || phase.value === 'open-failed')
        {
            return;
        }
        activeRead?.abort();
        generation += 1;
        plan.value = null;
        request = null;
        reason.value = null;
        if (version.value)
        {
            phase.value = 'preview';
        }
    }

    async function validate(inputs: ArticleTemplateInputs): Promise<void>
    {
        if (!version.value || phase.value === 'creating' || phase.value === 'create-retry' || phase.value === 'created' || phase.value === 'open-failed')
        {
            return;
        }
        editInputs();
        const selected = version.value;
        const current = generation;
        activeRead = new AbortController();
        const boundInputs = Object.freeze({ ...inputs });
        phase.value = 'planning';
        try
        {
            const result = await transport.plan({ templateId: selected.templateId, versionId: selected.versionId,
                versionDigest: selected.versionDigest, definitionRevision: selected.definitionRevision, inputs: boundInputs }, activeRead.signal);
            if (current !== generation)
            {
                return;
            }
            if (result.qualification !== 'qualified' || result.templateId !== selected.templateId || result.versionId !== selected.versionId
                || result.versionNumber !== selected.versionNumber || result.versionDigest !== selected.versionDigest
                || result.definitionRevision !== selected.definitionRevision || !/^[a-f0-9]{64}$/u.test(result.planDigest)
                || !/^[a-f0-9]{64}$/u.test(result.inputDigest) || !/^[a-f0-9]{64}$/u.test(result.sourceDigest)
                || result.inputs.title !== boundInputs.title || result.inputs.businessTimeUtc !== boundInputs.businessTimeUtc
                || result.inputs.timeZoneId !== boundInputs.timeZoneId || result.inputs.localeCode !== boundInputs.localeCode
                || !Number.isFinite(Date.parse(result.issuedAtUtc)) || Date.parse(result.issuedAtUtc) > options.now()
                || !Number.isFinite(Date.parse(result.expiresAtUtc)) || Date.parse(result.expiresAtUtc) <= options.now())
            {
                throw new ArticleTemplateInteractionError('article_template_plan_binding_invalid');
            }
            plan.value = Object.freeze({ ...result, inputs: boundInputs });
            phase.value = 'ready';
        }
        catch (error)
        {
            if (current === generation)
            {
                fail(error);
            }
        }
    }

    async function openCreated(): Promise<void>
    {
        if (!receipt.value || phase.value === 'creating')
        {
            return;
        }
        try
        {
            await host.openOrActivate(receipt.value.articleId);
            reason.value = null;
            phase.value = 'created';
        }
        catch
        {
            reason.value = 'article_created_open_failed';
            phase.value = 'open-failed';
        }
    }

    async function create(): Promise<void>
    {
        if (!canCreate.value || !plan.value)
        {
            return;
        }
        if (!request && Date.parse(plan.value.expiresAtUtc) <= options.now())
        {
            fail({ code: 'article_template_plan_expired' });
            return;
        }
        request ??= Object.freeze({ kind: 'explicit-template', requestId: options.newRequestId(),
            templateId: plan.value.templateId, versionId: plan.value.versionId, versionDigest: plan.value.versionDigest,
            planDigest: plan.value.planDigest, inputDigest: plan.value.inputDigest, inputs: plan.value.inputs });
        const retryingUncertainRequest = phase.value === 'create-retry';
        versionRead?.abort();
        versionRead = null;
        phase.value = 'creating';
        try
        {
            receipt.value = Object.freeze({ ...await host.create(request) });
            phase.value = 'created';
            await openCreated();
        }
        catch (error)
        {
            // Retain the exact request for a network retry; authority/stale failures require a fresh plan.
            const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
            if (code === 'network_error' || retryingUncertainRequest)
            {
                reason.value = typeof code === 'string' && /^[a-z][a-z0-9_:.]{0,127}$/u.test(code)
                    ? code : 'article_template_request_failed';
                phase.value = 'create-retry';
            }
            else
            {
                fail(error);
            }
        }
    }

    function cancel(): boolean
    {
        if (phase.value === 'creating' || phase.value === 'create-retry' || phase.value === 'open-failed')
        {
            return false;
        }
        invalidate();
        items.value = [];
        nextCursor.value = null;
        receipt.value = null;
        phase.value = 'closed';
        return true;
    }

    /** Main-new remains callable without a transport lookup or opening this picker. */
    async function createBlank(): Promise<CanonicalArticleCreateReceipt>
    {
        if (blankInFlight)
        {
            return blankInFlight;
        }
        if (blankOpenObligation.value)
        {
            const created = blankOpenObligation.value;
            await retryBlankOpen();
            return created;
        }
        blankRequest ??= Object.freeze({ kind: 'blank', requestId: options.newRequestId() });
        blankInFlight = (async () =>
        {
            // Assign the in-flight promise before invoking a host that may reject synchronously.
            await Promise.resolve();
            try
            {
                const created = await host.create(blankRequest);
                blankRequest = null;
                blankUncertain = false;
                blankReason.value = null;
                blankOpenObligation.value = Object.freeze({ ...created });
                await retryBlankOpen();
                return created;
            }
            catch (error)
            {
                const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
                blankUncertain ||= code === 'network_error';
                if (!blankUncertain)
                {
                    blankRequest = null;
                }
                blankReason.value = typeof code === 'string' && /^[a-z][a-z0-9_:.]{0,127}$/u.test(code)
                    ? code : 'article_create_request_failed';
                throw error;
            }
            finally
            {
                blankInFlight = null;
            }
        })();
        return blankInFlight;
    }

    async function retryBlankOpen(): Promise<void>
    {
        if (!blankOpenObligation.value)
        {
            return;
        }
        try
        {
            await host.openOrActivate(blankOpenObligation.value.articleId);
            blankOpenObligation.value = null;
        }
        catch
        {
            // The committed blank article stays available for navigation retry.
        }
    }

    return { phase, visible, items, nextCursor, version, versionChoices, nextVersionNumber, plan, receipt, blankOpenObligation, blankReason, reason, canCreate,
        search, select, loadVersions, selectVersion, editInputs, validate, create, cancel, createBlank, openCreated, retryBlankOpen };
}

function freezeVersion(value: ArticleTemplateVersion): ArticleTemplateVersion
{
    const defaults = value.defaults;
    return Object.freeze({ ...value, variables: Object.freeze([...value.variables]), defaults: Object.freeze({ ...defaults,
        tagIds: Object.freeze([...defaults.tagIds]), assetIds: Object.freeze([...defaults.assetIds]),
        propertyDefaults: Object.freeze(defaults.propertyDefaults.map(property => Object.freeze({ ...property, optionIds: Object.freeze([...property.optionIds]) }))),
        rightsProfile: defaults.rightsProfile ? Object.freeze({ ...defaults.rightsProfile }) : null,
        responsibilityProfile: defaults.responsibilityProfile ? Object.freeze({ ...defaults.responsibilityProfile }) : null,
        prepublishProfile: defaults.prepublishProfile ? Object.freeze({ ...defaults.prepublishProfile }) : null
    }) });
}
