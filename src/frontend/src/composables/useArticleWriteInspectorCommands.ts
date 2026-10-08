import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue';

import {
    articleWriteInspectorRegistry,
    type ArticleWriteInspectorView,
    type useArticleWriteInspector
} from '@/composables/useArticleWriteInspector';
import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands';
import { translate } from '@/locales';
import {
    createArticleDocumentContext,
    validateArticleDocumentContext,
    type ArticleDocumentContext
} from '@/services/authoring/articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';
import type { useAdminStore } from '@/store/admin';

export const articleInspectorCommandReceiptSchema = 'fsusblog.article-inspector-command-receipt.v1' as const;

type CommandContext = Parameters<FsusUiAuthoringCommand['run']>[0];
type InspectorOwner = ReturnType<typeof useArticleWriteInspector>;
type AdminAuthority = Pick<ReturnType<typeof useAdminStore>, 'adminState' | 'hasPermission'>;
type RejectionReason = 'no-document' | 'stale-document' | 'permission' | 'readonly' |
    'loading' | 'saving' | 'modal-active' | 'pending' | 'aborted' | 'handler-error' | 'target-unavailable';
type AvailabilityReason = Exclude<RejectionReason, 'handler-error' | 'target-unavailable'>;
const availabilityTranslationKeys = Object.freeze({
    'no-document': 'noDocument',
    'stale-document': 'staleDocument',
    permission: 'permission',
    readonly: 'readonly',
    loading: 'loading',
    saving: 'saving',
    'modal-active': 'modalActive',
    pending: 'pending',
    aborted: 'aborted'
} as const);

export interface ArticleInspectorCommandReceipt
{
    readonly schema: typeof articleInspectorCommandReceiptSchema;
    readonly commandId: string;
    readonly result: 'opened' | 'rejected' | 'canceled' | 'failed';
    readonly reason: RejectionReason | null;
    readonly contextDigest: string | null;
    readonly durationMs: number;
    readonly contentDigest: string;
}

interface InspectorCommandOptions
{
    readonly inspector: InspectorOwner;
    readonly admin: AdminAuthority;
    readonly documentContext: Readonly<Ref<ArticleDocumentContext | null>>;
    readonly loading: Readonly<Ref<boolean>>;
    readonly saving: Readonly<Ref<boolean>>;
    readonly modalActive: Readonly<Ref<boolean>>;
}

/** Verify only the inspector-opening result; this schema cannot attest to saving, publishing or loading data. */
export function verifyArticleInspectorCommandReceipt(value: unknown): value is ArticleInspectorCommandReceipt
{
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const fields = ['schema', 'commandId', 'result', 'reason', 'contextDigest', 'durationMs', 'contentDigest'];
    if (Object.keys(candidate).length !== fields.length || fields.some((field) => !Object.hasOwn(candidate, field)))
    {
        return false;
    }
    const reasons: readonly RejectionReason[] = [
        'no-document', 'stale-document', 'permission', 'readonly', 'loading', 'saving', 'modal-active',
        'pending', 'aborted', 'handler-error', 'target-unavailable'
    ];
    if (candidate.schema !== articleInspectorCommandReceiptSchema ||
        !articleWriteInspectorRegistry.some((view) => candidate.commandId === `fsusblog.core.inspector.${view.id}`) ||
        typeof candidate.result !== 'string' || !['opened', 'rejected', 'canceled', 'failed'].includes(candidate.result) ||
        (candidate.reason !== null && !reasons.includes(candidate.reason as RejectionReason)) ||
        (candidate.contextDigest !== null &&
            (typeof candidate.contextDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.contextDigest))) ||
        typeof candidate.durationMs !== 'number' || !Number.isFinite(candidate.durationMs) || candidate.durationMs < 0 ||
        (candidate.result === 'opened' && (candidate.reason !== null || candidate.contextDigest === null)) ||
        (candidate.result !== 'opened' && candidate.reason === null) ||
        (candidate.result === 'canceled' && candidate.reason !== 'aborted') ||
        (candidate.result === 'failed' && candidate.reason !== 'handler-error'))
    {
        return false;
    }
    const { contentDigest, ...unsigned } = candidate;
    return typeof contentDigest === 'string' && contentDigest === calculateOpenArticleDocumentDigest(unsigned);
}

/** Project the existing inspector views into the one FsusUI registry. No save or publish completion is inferred. */
export function useArticleWriteInspectorCommands(options: InspectorCommandOptions)
{
    const pending = shallowRef(false);
    const lastReceipt = shallowRef<ArticleInspectorCommandReceipt | null>(null);
    let currentController: AbortController | null = null;

    const unavailable = (context: CommandContext): AvailabilityReason | null =>
    {
        const document = options.documentContext.value;
        if (document === null)
        {
            return 'no-document';
        }
        try
        {
            if (!validateArticleDocumentContext(document) ||
                context.documentIdentity.id !== document.documentId ||
                context.documentIdentity.epoch !== document.documentEpoch ||
                context.revision !== document.sourceRevision ||
                createArticleDocumentContext({ ...document, content: context.value }).contextDigest !== document.contextDigest)
            {
                return 'stale-document';
            }
        }
        catch
        {
            return 'stale-document';
        }
        if (options.admin.adminState !== 'active' || !options.admin.hasPermission('article.write'))
        {
            return 'permission';
        }
        if (context.readonly)
        {
            return 'readonly';
        }
        if (options.loading.value)
        {
            return 'loading';
        }
        if (options.saving.value)
        {
            return 'saving';
        }
        if (options.modalActive.value)
        {
            return 'modal-active';
        }
        if (context.signal.aborted)
        {
            return 'aborted';
        }
        return null;
    };

    const cancel = (): void => currentController?.abort();
    const stop = watch(() => [
        options.documentContext.value?.contextDigest,
        options.admin.adminState,
        options.admin.hasPermission('article.write'),
        options.loading.value,
        options.saving.value,
        options.modalActive.value
    ], cancel, { flush: 'sync' });
    onScopeDispose(() =>
    {
        cancel();
        stop();
    });

    const run = async (view: ArticleWriteInspectorView, context: CommandContext) =>
    {
        const commandId = `fsusblog.core.inspector.${view}`;
        const contextDigest = options.documentContext.value?.contextDigest ?? null;
        const startedAt = performance.now();
        let recorded = false;
        const record = (result: ArticleInspectorCommandReceipt['result'], reason: RejectionReason | null): void =>
        {
            recorded = true;
            const receipt = {
                schema: articleInspectorCommandReceiptSchema,
                commandId,
                result,
                reason,
                contextDigest,
                durationMs: Math.max(0, performance.now() - startedAt)
            };
            lastReceipt.value = Object.freeze({
                ...receipt,
                contentDigest: calculateOpenArticleDocumentDigest(receipt)
            });
        };
        const reason = unavailable(context) ?? (pending.value ? 'pending' : null);
        if (reason)
        {
            record(reason === 'aborted' ? 'canceled' : 'rejected', reason);
            throw new Error(`Article inspector command unavailable: ${reason}.`);
        }

        const controller = new AbortController();
        currentController = controller;
        pending.value = true;
        const abort = (): void => controller.abort();
        context.signal.addEventListener('abort', abort, { once: true });
        let removeAbort: () => void = () => undefined;
        try
        {
            const canceled = new Promise<never>((_resolve, reject) =>
            {
                const rejectAbort = (): void => reject(new DOMException('Article inspector command canceled.', 'AbortError'));
                controller.signal.addEventListener('abort', rejectAbort, { once: true });
                removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
            });
            // Opening belongs to the inspector owner. Its completion is not a remote data receipt.
            await Promise.race([options.inspector.open(view), canceled]);
            controller.signal.throwIfAborted();
            const changed = unavailable(context);
            if (changed || options.documentContext.value?.contextDigest !== contextDigest)
            {
                record('rejected', changed ?? 'stale-document');
                throw new Error('Article inspector command became unavailable.');
            }
            const focused = await options.inspector.focusActiveView(view, controller.signal);
            controller.signal.throwIfAborted();
            if (unavailable(context) || options.documentContext.value?.contextDigest !== contextDigest ||
                options.inspector.activeInspector.value !== view || !focused)
            {
                record('rejected', 'target-unavailable');
                throw new Error('Article inspector target is not current and focused.');
            }
            record('opened', null);
            return { focus: 'none' as const };
        }
        catch (error: unknown)
        {
            if (controller.signal.aborted)
            {
                record('canceled', 'aborted');
            }
            else if (!recorded)
            {
                record('failed', 'handler-error');
            }
            throw error;
        }
        finally
        {
            context.signal.removeEventListener('abort', abort);
            removeAbort();
            if (currentController === controller)
            {
                currentController = null;
                pending.value = false;
            }
        }
    };

    const commands = computed<readonly FsusUiAuthoringCommand[]>(() => Object.freeze(
        articleWriteInspectorRegistry.map((view) => Object.freeze<FsusUiAuthoringCommand>({
            key: `fsusblog.core.inspector.${view.id}`,
            label: translate(`admin.articleInspector.commands.${view.id}`),
            group: translate('admin.articleInspector.commandGroup'),
            keywords: Object.freeze([translate(`admin.articleInspector.commands.${view.id}`)]),
            presentation: Object.freeze(['palette'] as const),
            when: () => true,
            enabled: (context) => unavailable(context) === null && !pending.value,
            disabledReason: (context) =>
            {
                const reason = unavailable(context) ?? (pending.value ? 'pending' : null);
                return reason === null ? undefined : translate(`admin.articleInspector.unavailable.${availabilityTranslationKeys[reason]}`);
            },
            run: (context) => run(view.id, context)
        }))
    ));

    return { commands, lastReceipt, pending, cancel };
}
