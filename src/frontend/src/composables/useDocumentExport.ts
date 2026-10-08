import { computed, shallowRef } from 'vue';


import { createDocumentExportCall } from '@/components/document-export/documentExportCall';
import type { DocumentExportCallState } from '@/components/document-export/documentExportCall';
import type {
    DocumentExportPresentation,
    DocumentExportSelection,
    DocumentExportUiPort
} from '@/components/document-export/documentExportUiPort';

import type { ShallowRef } from 'vue';

/**
 * One bounded, transient receipt view shared by all formats. Closing the panel
 * stops observation only; cancellation always calls the durable job authority.
 * Identity changes invalidate every pending response and clear private metadata.
 */
export function useDocumentExport<TSnapshot, TRequest>(port: DocumentExportUiPort<TSnapshot, TRequest>)
{
    const pageSize = 20;
    const snapshots = shallowRef<readonly TSnapshot[]>([]);
    const selected: ShallowRef<TSnapshot | null> = shallowRef<TSnapshot | null>(null);
    const offset = shallowRef(0);
    const open = shallowRef(false);
    const permitted = shallowRef(true);
    const loading = shallowRef(false);
    const queryFailure = shallowRef('');
    const submission = shallowRef<DocumentExportCallState<TSnapshot>>({ phase: 'idle' });
    const actionState = shallowRef<DocumentExportCallState<TSnapshot | void>>({ phase: 'idle' });
    const actionName = shallowRef('');
    const actionTaskId = shallowRef('');
    const reconciling = shallowRef(false);
    let epoch = 0;
    let querySequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let downloadController: AbortController | undefined;

    const views = computed(() => snapshots.value.map(port.inspect));
    const selectedView = computed(() => selected.value === null ? null : port.inspect(selected.value));
    const busy = computed(() => reconciling.value || submission.value.phase === 'pending' || actionState.value.phase === 'pending');

    function stopPolling(): void
    {
        clearTimeout(timer);
        timer = undefined;
    }

    function accept(snapshot: TSnapshot): void
    {
        const incoming = port.inspect(snapshot);
        const current = snapshots.value.find((item) => port.inspect(item).taskId === incoming.taskId);
        if (current && port.inspect(current).version > incoming.version)
        {
            return;
        }
        snapshots.value = snapshots.value.map((item) =>
            port.inspect(item).taskId === incoming.taskId ? snapshot : item);
        if (selected.value === null || port.inspect(selected.value).taskId === incoming.taskId)
        {
            if (selected.value === null || port.inspect(selected.value).version <= incoming.version)
            {
                selected.value = snapshot;
            }
        }
    }

    function invalidate(): void
    {
        epoch += 1;
        querySequence += 1;
        stopPolling();
        downloadController?.abort();
        downloadController = undefined;
        snapshots.value = [];
        selected.value = null;
        offset.value = 0;
        loading.value = false;
        queryFailure.value = '';
        submitCall.reset();
        actionCall?.reset();
        actionCall = undefined;
        actionName.value = '';
        actionTaskId.value = '';
        reconciling.value = false;
    }

    function revoke(): void
    {
        permitted.value = false;
        invalidate();
        queryFailure.value = 'permission-revoked';
    }

    const submitCall = createDocumentExportCall<TRequest, TSnapshot>({
        captureRequest: port.captureRequest,
        execute: (request) => port.request(request),
        classifyFailure: port.classifyFailure,
        permissionRevoked: revoke,
        allowUncertainRetry: true,
        changed: (state) =>
        {
            submission.value = state;
            if (state.phase === 'confirmed')
            {
                selected.value = state.result;
                void refresh();
            }
        }
    });
    let actionCall: ReturnType<typeof createDocumentExportCall<string, TSnapshot | void>> | undefined;

    function schedulePoll(): void
    {
        stopPolling();
        if (open.value && permitted.value && views.value.some((view) => [1, 2, 3, 4].includes(view.status)))
        {
            timer = setTimeout(() => void refresh(), 2000);
        }
    }

    async function refresh(nextOffset = offset.value): Promise<void>
    {
        if (!open.value || !permitted.value)
        {
            return;
        }
        const callEpoch = epoch;
        const sequence = ++querySequence;
        loading.value = true;
        stopPolling();
        try
        {
            const page = await port.list(nextOffset, pageSize);
            if (epoch !== callEpoch || sequence !== querySequence || !open.value)
            {
                return;
            }
            if (page.length > pageSize)
            {
                throw new Error('document_export_page_limit');
            }
            const previous = new Map(snapshots.value.map((snapshot) => [port.inspect(snapshot).taskId, snapshot]));
            snapshots.value = page.map((snapshot) =>
            {
                const view = port.inspect(snapshot);
                const known = previous.get(view.taskId);
                return known && port.inspect(known).version > view.version ? known : snapshot;
            });
            offset.value = nextOffset;
            queryFailure.value = '';
            if (selected.value !== null)
            {
                const id = port.inspect(selected.value).taskId;
                const latest = snapshots.value.find((snapshot) => port.inspect(snapshot).taskId === id);
                if (latest)
                {
                    accept(latest);
                }
                else
                {
                    selected.value = null;
                }
            }
        }
        catch (error: unknown)
        {
            if (epoch === callEpoch && sequence === querySequence)
            {
                const failure = port.classifyFailure(error);
                if (failure === 'permission-revoked')
                {
                    revoke();
                }
                else
                {
                    queryFailure.value = failure;
                }
            }
        }
        finally
        {
            if (epoch === callEpoch && sequence === querySequence)
            {
                loading.value = false;
                schedulePoll();
            }
        }
    }

    function setOpen(value: boolean): void
    {
        open.value = value;
        if (value)
        {
            void refresh();
        }
        else
        {
            querySequence += 1;
            loading.value = false;
            stopPolling();
        }
    }

    function changeIdentity(): void
    {
        invalidate();
        permitted.value = true;
        if (open.value)
        {
            void refresh();
        }
    }

    async function submit(selection: Readonly<DocumentExportSelection>): Promise<void>
    {
        if (!permitted.value || busy.value || submission.value.phase === 'uncertain')
        {
            return;
        }
        const source = port.sources.find((item) => item.id === selection.sourceId);
        const format = port.catalog.find((item) => item.id === selection.formatId);
        if (!source || !format?.available || !format.layouts.includes(selection.layout)
            || !format.themes.includes(selection.theme))
        {
            submission.value = { phase: 'rejected' };
            return;
        }
        await submitCall.start(port.prepareRequest(Object.freeze({ ...selection })));
    }

    function select(taskId: string): void
    {
        selected.value = snapshots.value.find((snapshot) => port.inspect(snapshot).taskId === taskId) ?? null;
    }

    function actionAllowed(name: string, view: DocumentExportPresentation): boolean
    {
        if (!permitted.value || busy.value || queryFailure.value !== '' || actionState.value.phase === 'uncertain')
        {
            return false;
        }
        if (view.status < 1 || view.status > 10)
        {
            return name === 'status';
        }
        if (name === 'cancel')
        {
            return [1, 2, 3, 4].includes(view.status);
        }
        if (name === 'retry')
        {
            return view.status === 7;
        }
        if (name === 'download')
        {
            const output = view.output;
            return view.status === 6 && !view.diagnostic && output !== null && !output.deleted
                && Date.parse(output.expiresAt) > Date.now();
        }
        return name === 'status' || (name === 'delete' && view.output !== null && !view.output.deleted);
    }

    async function act(name: 'cancel' | 'retry' | 'download' | 'delete' | 'status', taskId: string): Promise<void>
    {
        const snapshot = selected.value;
        if (snapshot === null || port.inspect(snapshot).taskId !== taskId
            || !actionAllowed(name, port.inspect(snapshot)) || actionState.value.phase === 'uncertain')
        {
            return;
        }
        actionCall?.reset();
        actionName.value = name;
        actionTaskId.value = taskId;
        if (name === 'download')
        {
            downloadController = new AbortController();
        }
        const deliverySignal = downloadController?.signal;
        actionCall = createDocumentExportCall<string, TSnapshot | void>({
            captureRequest: (value) => value,
            execute: (id) => name === 'download'
                ? port.download(id, deliverySignal!)
                : port[name](id),
            classifyFailure: port.classifyFailure,
            permissionRevoked: revoke,
            allowUncertainRetry: name === 'cancel' || name === 'delete' || name === 'status',
            changed: (state) =>
            {
                actionState.value = state;
                if (state.phase === 'confirmed' && state.result !== undefined)
                {
                    accept(state.result);
                    void refresh();
                }
            }
        });
        await actionCall.start(taskId);
    }

    async function reconcile(): Promise<void>
    {
        if (!permitted.value || busy.value || actionTaskId.value === '' || actionState.value.phase !== 'uncertain')
        {
            return;
        }
        const callEpoch = epoch;
        const currentAction = actionCall;
        const taskId = actionTaskId.value;
        reconciling.value = true;
        try
        {
            const snapshot = await port.status(taskId);
            if (epoch === callEpoch && actionCall === currentAction)
            {
                accept(snapshot);
                currentAction?.reset();
                void refresh();
            }
        }
        catch (error: unknown)
        {
            if (epoch === callEpoch && port.classifyFailure(error) === 'permission-revoked')
            {
                revoke();
            }
        }
        finally
        {
            if (epoch === callEpoch && actionCall === currentAction)
            {
                reconciling.value = false;
            }
        }
    }

    function dispose(): void
    {
        open.value = false;
        invalidate();
    }

    async function retrySubmission(): Promise<void>
    {
        if (permitted.value && !busy.value)
        {
            await submitCall.retry();
        }
    }

    async function retryAction(): Promise<void>
    {
        if (permitted.value && !busy.value)
        {
            await actionCall?.retry();
        }
    }

    return {
        views, selectedView, offset, pageSize, open, permitted, loading, queryFailure,
        submission, actionState, actionName, busy, setOpen, changeIdentity, refresh,
        submit, retrySubmission, select, act, reconcile,
        retryAction, actionAllowed, dispose
    };
}
