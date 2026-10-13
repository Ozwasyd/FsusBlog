import { describe, expect, it, vi } from 'vitest';

import type { ArticleTemplateCreateHost, ArticleTemplateInputs, ArticleTemplatePlan, ArticleTemplateTransport, ArticleTemplateVersion } from '@/api/articleTemplates';
import { useArticleTemplatePicker } from '@/composables/useArticleTemplatePicker';

const digest = 'a'.repeat(64);
const now = Date.parse('2026-10-08T12:00:00Z');
const inputs: ArticleTemplateInputs = { title: 'explicit', businessTimeUtc: '2026-10-08T12:00:00Z', timeZoneId: 'UTC', localeCode: 'zh-CN' };

function fixture()
{
    const version: ArticleTemplateVersion = {
        templateId: 'template-1', versionId: 'version-1', versionNumber: 1, versionDigest: digest,
        definitionRevision: 1, name: 'Tutorial', description: null, status: 'active', scope: 'personal', canManage: true,
        source: '# {{title}}', variables: ['title'], scopeRevision: 1, provenanceCount: 0,
        defaults: { titlePlaceholder: null, summaryPlaceholder: null, categoryId: null, tagIds: [], assetIds: [],
            propertyDefaults: [], rightsProfile: null, responsibilityProfile: null, prepublishProfile: null }
    };
    const plan: ArticleTemplatePlan = {
        templateId: version.templateId, versionId: version.versionId, versionNumber: 1, versionDigest: digest,
        definitionRevision: 1, inputs, qualification: 'qualified', inputDigest: digest, sourceDigest: digest,
        planDigest: digest, issuedAtUtc: '2026-10-08T12:00:00Z', expiresAtUtc: '2026-10-08T12:15:00Z'
    };
    const transport: ArticleTemplateTransport = {
        listVersions: vi.fn().mockResolvedValue({ items: [], nextVersionNumber: null }),
        list: vi.fn().mockResolvedValue({ items: [version], nextCursor: null }),
        getVersion: vi.fn().mockResolvedValue(version), plan: vi.fn().mockResolvedValue(plan), manage: vi.fn()
    };
    const host: ArticleTemplateCreateHost = {
        create: vi.fn().mockResolvedValue({ articleId: 123, receiptId: 'receipt', contentDigest: digest }),
        openOrActivate: vi.fn().mockResolvedValue(undefined)
    };
    const clock = { value: now };
    const newRequestId = vi.fn().mockReturnValueOnce('request-1').mockReturnValue('request-2');
    const picker = useArticleTemplatePicker(transport, host, { newRequestId, now: () => clock.value });
    async function ready()
    {
        await picker.search();
        await picker.select(picker.items.value[0]!);
        await picker.validate(inputs);
    }
    return { picker, transport, host, version, plan, clock, ready };
}

describe('explicit article template interaction', () =>
{
    it('shares an in-flight blank create and reuses the exact uncertain request', async () =>
    {
        const { picker, host } = fixture();
        vi.mocked(host.create).mockRejectedValueOnce({ code: 'network_error' });
        const first = picker.createBlank();
        const overlapping = picker.createBlank();
        await expect(first).rejects.toMatchObject({ code: 'network_error' });
        await expect(overlapping).rejects.toMatchObject({ code: 'network_error' });
        expect(host.create).toHaveBeenCalledTimes(1);
        await picker.createBlank();
        expect(vi.mocked(host.create).mock.calls[0]![0]).toBe(vi.mocked(host.create).mock.calls[1]![0]);
    });
    it('selects an explicitly requested immutable version from bounded version pages', async () =>
    {
        const { picker, transport, version } = fixture();
        const older = { versionId: 'old-version', versionNumber: 2, versionDigest: 'b'.repeat(64) };
        vi.mocked(transport.listVersions).mockResolvedValue({ items: [older], nextVersionNumber: 2 });
        await picker.search();
        await picker.select(picker.items.value[0]!);
        await picker.loadVersions();
        expect(transport.listVersions).toHaveBeenCalledWith({ templateId: version.templateId, afterVersionNumber: null, limit: 50 }, expect.any(AbortSignal));
        expect(picker.version.value?.versionId).toBe(version.versionId);
        vi.mocked(transport.getVersion).mockResolvedValue({ ...version, ...older });
        await picker.selectVersion(picker.versionChoices.value[0]!);
        expect(picker.version.value?.versionId).toBe(older.versionId);
        expect(picker.plan.value).toBeNull();
    });

    it('pages through 1000 templates without accumulating rows or automatic selection', async () =>
    {
        const { picker, transport, version, host } = fixture();
        vi.mocked(transport.list).mockImplementation(async ({ cursor }) =>
        {
            const start = cursor === null ? 0 : Number(cursor);
            return { items: Array.from({ length: 50 }, (_, index) => ({ ...version, templateId: `template-${start + index}` })),
                nextCursor: start < 950 ? String(start + 50) : null };
        });
        for (let page = 0; page < 20; page += 1)
        {
            await picker.search('', page === 0 ? null : picker.nextCursor.value);
            expect(picker.items.value).toHaveLength(50);
            expect(picker.version.value).toBeNull();
        }
        expect(picker.nextCursor.value).toBeNull();
        expect(transport.list).toHaveBeenCalledTimes(20);
        picker.cancel();
        expect(host.create).not.toHaveBeenCalled();
    });
    it('locks selection and inputs while a create outcome is uncertain', async () =>
    {
        const { picker, transport, host, ready } = fixture();
        await ready();
        vi.mocked(host.create).mockRejectedValueOnce({ code: 'network_error' }).mockRejectedValueOnce({ code: 'permission_lost' });
        await picker.create();
        expect(picker.cancel()).toBe(false);
        picker.editInputs();
        await picker.search('different');
        await picker.validate({ ...inputs, title: 'different' });
        expect(transport.list).toHaveBeenCalledTimes(1);
        expect(transport.plan).toHaveBeenCalledTimes(1);
        await picker.create();
        expect(picker.phase.value).toBe('create-retry');
        expect(vi.mocked(host.create).mock.calls[0]![0]).toBe(vi.mocked(host.create).mock.calls[1]![0]);
    });
    it('main new creates blank without template reads or selection', async () =>
    {
        const { picker, host, transport } = fixture();
        await picker.createBlank();
        expect(host.create).toHaveBeenCalledWith({ kind: 'blank', requestId: 'request-1' });
        expect(host.openOrActivate).toHaveBeenCalledWith(123);
        expect(transport.list).not.toHaveBeenCalled();
        expect(transport.plan).not.toHaveBeenCalled();
        expect(picker.visible.value).toBe(false);
    });

    it('blank survives template service failure and records a committed navigation obligation', async () =>
    {
        const { picker, host, transport } = fixture();
        vi.mocked(transport.list).mockRejectedValue({ code: 'service_unavailable' });
        vi.mocked(host.openOrActivate).mockRejectedValueOnce(new Error('open failed'));
        await picker.search();
        expect(await picker.createBlank()).toMatchObject({ articleId: 123 });
        expect(picker.blankOpenObligation.value?.articleId).toBe(123);
        await picker.retryBlankOpen();
        expect(picker.blankOpenObligation.value).toBeNull();
        expect(host.create).toHaveBeenCalledTimes(1);
    });

    it('never auto-selects and all pre-create cancel states have zero writes', async () =>
    {
        const { picker, transport, host } = fixture();
        await picker.search();
        expect(picker.version.value).toBeNull();
        expect(picker.canCreate.value).toBe(false);
        expect(picker.cancel()).toBe(true);
        await picker.search();
        await picker.select(picker.items.value[0]!);
        expect(picker.cancel()).toBe(true);
        expect(host.create).not.toHaveBeenCalled();
        expect(transport.plan).not.toHaveBeenCalled();
        await picker.search();
        expect(picker.version.value).toBeNull();
    });

    it('consumes an exact qualified plan through the canonical host', async () =>
    {
        const { picker, host, transport, ready } = fixture();
        await ready();
        await Promise.all([picker.create(), picker.create()]);
        expect(host.create).toHaveBeenCalledTimes(1);
        expect(host.create).toHaveBeenCalledWith({ kind: 'explicit-template', requestId: 'request-1',
            templateId: 'template-1', versionId: 'version-1', versionDigest: digest, inputDigest: digest, planDigest: digest, inputs });
        expect(transport.plan).toHaveBeenCalledTimes(1);
        expect(host.openOrActivate).toHaveBeenCalledWith(123);
    });

    it.each(['versionId', 'versionDigest', 'definitionRevision'] as const)('rejects selection drift in %s without fallback', async field =>
    {
        const { picker, transport, host, version } = fixture();
        vi.mocked(transport.getVersion).mockResolvedValue({ ...version, [field]: field === 'definitionRevision' ? 2 : 'changed' });
        await picker.search();
        await picker.select(picker.items.value[0]!);
        await picker.create();
        expect(picker.reason.value).toBe('article_template_selection_stale');
        expect(host.create).not.toHaveBeenCalled();
    });

    it.each(['retired', 'deleted'] as const)('rejects %s versions without a writer spawn', async status =>
    {
        const { picker, transport, host, version } = fixture();
        vi.mocked(transport.getVersion).mockResolvedValue({ ...version, status });
        await picker.search();
        await picker.select(picker.items.value[0]!);
        expect(host.create).not.toHaveBeenCalled();
        expect(picker.version.value).toBeNull();
    });

    it('drops late plan completion after cancel', async () =>
    {
        const { picker, transport, host, plan } = fixture();
        let resolvePlan!: (value: ArticleTemplatePlan) => void;
        vi.mocked(transport.plan).mockImplementation(() => new Promise(resolve => { resolvePlan = resolve; }));
        await picker.search();
        await picker.select(picker.items.value[0]!);
        const pending = picker.validate(inputs);
        picker.cancel();
        resolvePlan(plan);
        await pending;
        expect(picker.phase.value).toBe('closed');
        expect(picker.plan.value).toBeNull();
        expect(host.create).not.toHaveBeenCalled();
    });

    it('invalidates the plan on variable edits', async () =>
    {
        const { picker, host, ready } = fixture();
        await ready();
        picker.editInputs();
        await picker.create();
        expect(picker.phase.value).toBe('preview');
        expect(host.create).not.toHaveBeenCalled();
    });

    it('rejects a mismatched plan input and reports only a safe reason', async () =>
    {
        const { picker, host, transport, plan, ready } = fixture();
        vi.mocked(transport.plan).mockResolvedValue({ ...plan, inputs: { ...inputs, title: 'different' } });
        await ready();
        await picker.create();
        expect(picker.reason.value).toBe('article_template_plan_binding_invalid');
        expect(host.create).not.toHaveBeenCalled();
        vi.mocked(transport.list).mockRejectedValue(new Error('private source and secret URL'));
        await picker.search();
        expect(picker.reason.value).toBe('article_template_request_failed');
    });

    it('expires an unsubmitted plan but preserves exact replay after an uncertain network outcome', async () =>
    {
        const { picker, host, clock, ready } = fixture();
        await ready();
        vi.mocked(host.create).mockRejectedValueOnce({ code: 'network_error' });
        await picker.create();
        clock.value += 16 * 60 * 1000;
        await picker.create();
        expect(vi.mocked(host.create).mock.calls[0]![0]).toBe(vi.mocked(host.create).mock.calls[1]![0]);
        expect(host.create).toHaveBeenCalledTimes(2);
    });

    it('never creates again when committed navigation failed', async () =>
    {
        const { picker, host, ready } = fixture();
        await ready();
        vi.mocked(host.openOrActivate).mockRejectedValueOnce(new Error('open failed'));
        await picker.create();
        expect(picker.phase.value).toBe('open-failed');
        expect(picker.cancel()).toBe(false);
        await picker.create();
        await picker.openCreated();
        expect(picker.phase.value).toBe('created');
        expect(host.create).toHaveBeenCalledTimes(1);
    });

    it('bounds list requests and rejects oversized responses', async () =>
    {
        const { picker, transport, version } = fixture();
        vi.mocked(transport.list).mockResolvedValue({ items: Array.from({ length: 51 }, () => version), nextCursor: null });
        await picker.search('query', 'exact-cursor');
        expect(transport.list).toHaveBeenCalledWith({ query: 'query', cursor: 'exact-cursor', limit: 50 }, expect.any(AbortSignal));
        expect(picker.reason.value).toBe('article_template_list_binding_invalid');
    });
});
