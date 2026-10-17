export const authoringInspectorSchema = 'fsusblog.authoring-inspector.v1' as const;
export const authoringInspectorBudgets = Object.freeze({
    contributions: 1000, active: 8, nodes: 32, rows: 100, columns: 8,
    commands: 8, payloadBytes: 64 * 1024, textCharacters: 2048, deadlineMilliseconds: 30000
});

export interface AuthoringInspectorBinding {
    readonly pluginId: string;
    readonly pluginVersion: string;
    readonly packageSha256: string;
    readonly runtimeIdentity: string;
    readonly lifecycleGeneration: number;
    readonly articleId: string;
    readonly documentId: string;
    readonly documentEpoch: number;
    readonly sourceRevision: number;
    readonly viewId: string;
    readonly requestId: string;
    readonly deadline: number;
    readonly grantId: string;
    readonly grantDigest: string;
    readonly scope: Readonly<{ kind: 'article-metadata'; }> |
        Readonly<{ kind: 'document-range'; start: number; end: number; }> |
        Readonly<{ kind: 'document-full'; }>;
}

export interface AuthoringInspectorCommandReference {
    readonly commandId: string;
    readonly labelReference: string;
}

export type AuthoringInspectorNode =
    | Readonly<{ kind: 'values'; id: string; rows: readonly Readonly<{
        id: string; labelReference: string; value: string;
    }>[]; }>
    | Readonly<{ kind: 'list'; id: string; items: readonly string[]; }>
    | Readonly<{ kind: 'table'; id: string; columns: readonly Readonly<{
        id: string; labelReference: string;
    }>[]; rows: readonly Readonly<{ id: string; cells: readonly string[]; }>[]; }>
    | Readonly<{ kind: 'status'; id: string; messageReference: string; }>
    | Readonly<{ kind: 'diagnostic'; id: string; code: string;
        severity: 'info' | 'warning' | 'error'; messageReference: string; }>;

export interface AuthoringInspectorModel {
    readonly sectionId: string;
    readonly titleReference: string;
    readonly state: 'ready' | 'loading' | 'empty' | 'error' | 'permission' | 'unsupported';
    readonly nodes: readonly AuthoringInspectorNode[];
    readonly commands: readonly AuthoringInspectorCommandReference[];
}

export interface AuthoringInspectorResult {
    readonly schema: typeof authoringInspectorSchema;
    readonly binding: AuthoringInspectorBinding;
    readonly model: AuthoringInspectorModel;
    readonly modelSha256: string;
}

// This port belongs to the host. A matching string digest never grants access:
// the host must check its real read grant, package and document lifetime owners.
export interface AuthoringInspectorAuthority {
    isCurrent(binding: AuthoringInspectorBinding): boolean;
    permitsRead(binding: AuthoringInspectorBinding): boolean;
    commandEnabled(binding: AuthoringInspectorBinding, commandId: string): boolean;
    signal(binding: AuthoringInspectorBinding): AbortSignal;
    localize(reference: string): string;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> =>
{
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) =>
            !('value' in descriptor) || !descriptor.enumerable))
    {
        throw new TypeError('Inspector requires a closed data object.');
    }
    return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> =>
{
    const object = record(value);
    if (Reflect.ownKeys(object).length !== keys.length || keys.some((key) =>
        !Object.hasOwn(object, key) || !('value' in Object.getOwnPropertyDescriptor(object, key)!)))
    {
        throw new TypeError('Inspector contains unknown or missing fields.');
    }
    return object;
};
const text = (value: unknown, maximum = authoringInspectorBudgets.textCharacters): string =>
{
    if (typeof value !== 'string' || value.length > maximum || Array.from(value).some((character) =>
    {
        const point = character.codePointAt(0)!;
        return point < 32 && point !== 9 && point !== 10 && point !== 13;
    }))
    {
        throw new TypeError('Inspector text exceeds its closed bound.');
    }
    return value;
};
const identity = (value: unknown): string =>
{
    const result = text(value, 256);
    if (result.length === 0 || result.trim() !== result || /\s/u.test(result))
    {
        throw new TypeError('Inspector identity is missing or malformed.');
    }
    return result;
};
const integer = (value: unknown, minimum: number): number =>
{
    if (!Number.isSafeInteger(value) || Number(value) < minimum)
    {
        throw new TypeError('Inspector numeric identity is invalid.');
    }
    return Number(value);
};
const digest = (value: unknown): string =>
{
    if (typeof value !== 'string' || !digestPattern.test(value))
    {
        throw new TypeError('Inspector digest is invalid.');
    }
    return value;
};
const array = (value: unknown, maximum: number): readonly unknown[] =>
{
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1)
    {
        throw new TypeError('Inspector collection exceeds its closed bound.');
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index++)
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        {
            throw new TypeError('Inspector collection requires plain dense data.');
        }
        snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
};
const unique = (ids: readonly string[]): void =>
{
    if (new Set(ids).size !== ids.length)
    {
        throw new TypeError('Inspector identities conflict.');
    }
};

export const parseAuthoringInspectorBinding = (input: unknown): AuthoringInspectorBinding =>
{
    const value = exact(input, ['pluginId', 'pluginVersion', 'packageSha256', 'runtimeIdentity',
        'lifecycleGeneration', 'articleId', 'documentId', 'documentEpoch', 'sourceRevision',
        'viewId', 'requestId', 'deadline', 'grantId', 'grantDigest', 'scope']);
    const scope = record(value.scope);
    let closedScope: AuthoringInspectorBinding['scope'];
    if (scope.kind === 'article-metadata' || scope.kind === 'document-full')
    {
        exact(scope, ['kind']);
        closedScope = Object.freeze({ kind: scope.kind });
    }
    else if (scope.kind === 'document-range')
    {
        exact(scope, ['kind', 'start', 'end']);
        const start = integer(scope.start, 0);
        const end = integer(scope.end, start);
        closedScope = Object.freeze({ kind: 'document-range', start, end });
    }
    else
    {
        throw new TypeError('Inspector read scope is unknown.');
    }
    return Object.freeze({
        pluginId: identity(value.pluginId), pluginVersion: identity(value.pluginVersion),
        packageSha256: digest(value.packageSha256), runtimeIdentity: digest(value.runtimeIdentity),
        lifecycleGeneration: integer(value.lifecycleGeneration, 1), articleId: identity(value.articleId),
        documentId: identity(value.documentId), documentEpoch: integer(value.documentEpoch, 1),
        sourceRevision: integer(value.sourceRevision, 0), viewId: identity(value.viewId),
        requestId: identity(value.requestId), deadline: integer(value.deadline, 1),
        grantId: identity(value.grantId), grantDigest: digest(value.grantDigest), scope: closedScope
    });
};

export const parseAuthoringInspectorModel = (input: unknown): AuthoringInspectorModel =>
{
    const value = exact(input, ['sectionId', 'titleReference', 'state', 'nodes', 'commands']);
    if (typeof value.state !== 'string' || !['ready', 'loading', 'empty', 'error', 'permission', 'unsupported'].includes(value.state))
    {
        throw new TypeError('Inspector state is unknown.');
    }
    const nodes = array(value.nodes, authoringInspectorBudgets.nodes).map((inputNode): AuthoringInspectorNode =>
    {
        const node = record(inputNode);
        const id = identity(node.id);
        if (node.kind === 'values')
        {
            exact(node, ['kind', 'id', 'rows']);
            const rows = array(node.rows, authoringInspectorBudgets.rows).map((item) =>
            {
                const row = exact(item, ['id', 'labelReference', 'value']);
                return Object.freeze({ id: identity(row.id), labelReference: identity(row.labelReference), value: text(row.value) });
            });
            unique(rows.map((row) => row.id));
            return Object.freeze({ kind: 'values', id, rows: Object.freeze(rows) });
        }
        if (node.kind === 'list')
        {
            exact(node, ['kind', 'id', 'items']);
            return Object.freeze({ kind: 'list', id, items: Object.freeze(array(node.items, authoringInspectorBudgets.rows).map((item) => text(item))) });
        }
        if (node.kind === 'table')
        {
            exact(node, ['kind', 'id', 'columns', 'rows']);
            const columns = array(node.columns, authoringInspectorBudgets.columns).map((item) =>
            {
                const column = exact(item, ['id', 'labelReference']);
                return Object.freeze({ id: identity(column.id), labelReference: identity(column.labelReference) });
            });
            if (!columns.length)
            {
                throw new TypeError('Inspector table requires registered columns.');
            }
            unique(columns.map((column) => column.id));
            const rows = array(node.rows, authoringInspectorBudgets.rows).map((item) =>
            {
                const row = exact(item, ['id', 'cells']);
                const cells = array(row.cells, columns.length).map((cell) => text(cell));
                if (cells.length !== columns.length)
                {
                    throw new TypeError('Inspector table cells do not match its columns.');
                }
                return Object.freeze({ id: identity(row.id), cells: Object.freeze(cells) });
            });
            unique(rows.map((row) => row.id));
            return Object.freeze({ kind: 'table', id, columns: Object.freeze(columns), rows: Object.freeze(rows) });
        }
        if (node.kind === 'status')
        {
            exact(node, ['kind', 'id', 'messageReference']);
            return Object.freeze({ kind: 'status', id, messageReference: identity(node.messageReference) });
        }
        if (node.kind === 'diagnostic')
        {
            exact(node, ['kind', 'id', 'messageReference', 'code', 'severity']);
            if (typeof node.severity !== 'string' || !['info', 'warning', 'error'].includes(node.severity))
            {
                throw new TypeError('Inspector diagnostic severity is unknown.');
            }
            return Object.freeze({ kind: 'diagnostic', id, code: identity(node.code),
                severity: node.severity as 'info' | 'warning' | 'error', messageReference: identity(node.messageReference) });
        }
        throw new TypeError('Inspector node kind is unknown.');
    });
    unique(nodes.map((node) => node.id));
    const commands = array(value.commands, authoringInspectorBudgets.commands).map((item) =>
    {
        const command = exact(item, ['commandId', 'labelReference']);
        return Object.freeze({ commandId: identity(command.commandId), labelReference: identity(command.labelReference) });
    });
    unique(commands.map((command) => command.commandId));
    if (value.state !== 'ready' && (nodes.length || commands.length))
    {
        throw new TypeError('Inspector unavailable state cannot carry a model or actions.');
    }
    const model = Object.freeze({ sectionId: identity(value.sectionId), titleReference: identity(value.titleReference),
        state: value.state as AuthoringInspectorModel['state'], nodes: Object.freeze(nodes), commands: Object.freeze(commands) });
    if (encoder.encode(JSON.stringify(model)).byteLength > authoringInspectorBudgets.payloadBytes)
    {
        throw new RangeError('Inspector model exceeds its byte budget.');
    }
    return model;
};

export const computeAuthoringInspectorModelDigest = async (input: unknown): Promise<string> =>
{
    const model = parseAuthoringInspectorModel(input);
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(model)));
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const inspectorBindingIsCurrent = (
    binding: AuthoringInspectorBinding, authority: AuthoringInspectorAuthority, now = Date.now()
): boolean =>
{
    const signal = authority.signal(binding);
    if (binding.deadline <= now || signal.aborted ||
        !authority.isCurrent(binding) || !authority.permitsRead(binding))
    {
        return false;
    }
    return !signal.aborted && binding.deadline > Date.now();
};

// One host-owned session owns cancellation and accepted data. It executes no
// plugin callback, fetch, observer, document write or secondary renderer. Its
// only timer enforces the bounded deadline and is released on cancellation.
export class AuthoringInspectorSession
{
    private generation = 0;
    private controller: AbortController | undefined;
    private detach: (() => void) | undefined;
    private accepted: AuthoringInspectorResult | undefined;
    private binding: AuthoringInspectorBinding | undefined;
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private readonly listeners = new Set<() => void>();

    constructor(readonly authority: AuthoringInspectorAuthority)
    {}

    subscribe(listener: () => void): () => void
    {
        if (this.listeners.size >= 8)
        {
            throw new RangeError('Inspector host subscriptions exceed their bound.');
        }
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get current(): AuthoringInspectorResult | undefined
    {
        const accepted = this.accepted;
        const generation = this.generation;
        const controller = this.controller;
        if (!accepted || !controller)
        {
            return undefined;
        }
        let permitted: boolean;
        try
        {
            permitted = inspectorBindingIsCurrent(accepted.binding, this.authority);
        }
        catch
        {
            permitted = false;
        }
        if (generation !== this.generation || controller !== this.controller ||
            accepted !== this.accepted)
        {
            return undefined;
        }
        if (!permitted || controller.signal.aborted || accepted.binding.deadline <= Date.now())
        {
            this.cancel();
            return undefined;
        }
        return accepted;
    }

    begin(input: unknown): AbortSignal
    {
        const generation = this.generation + 1;
        this.cancel();
        if (this.generation !== generation)
        {
            return AbortSignal.abort();
        }
        const binding = parseAuthoringInspectorBinding(input);
        const permitted = inspectorBindingIsCurrent(binding, this.authority);
        if (this.generation !== generation)
        {
            return AbortSignal.abort();
        }
        if (!permitted ||
            binding.deadline - Date.now() > authoringInspectorBudgets.deadlineMilliseconds)
        {
            throw new Error('Inspector read is unauthorized or stale.');
        }
        const controller = new AbortController();
        this.binding = binding;
        this.controller = controller;
        const owns = (): boolean => generation === this.generation && this.controller === controller;
        const revoke = (): void =>
        {
            if (owns())
            {
                this.cancel();
            }
        };
        this.timeout = setTimeout(revoke, Math.max(0, binding.deadline - Date.now()));
        let detach: (() => void) | undefined;
        try
        {
            const hostSignal = this.authority.signal(binding);
            if (!owns())
            {
                return controller.signal;
            }
            const permitted = !hostSignal.aborted && this.authority.isCurrent(binding) &&
                this.authority.permitsRead(binding);
            if (!owns())
            {
                return controller.signal;
            }
            if (!permitted || hostSignal.aborted || binding.deadline <= Date.now())
            {
                revoke();
                return controller.signal;
            }
            detach = () => hostSignal.removeEventListener('abort', revoke);
            this.detach = detach;
            hostSignal.addEventListener('abort', revoke, { once: true });
            if (!owns())
            {
                detach();
                return controller.signal;
            }
            if (hostSignal.aborted || binding.deadline <= Date.now())
            {
                revoke();
            }
            return controller.signal;
        }
        catch (error)
        {
            detach?.();
            revoke();
            throw error;
        }
    }

    async accept(input: unknown): Promise<AuthoringInspectorResult>
    {
        const generation = this.generation;
        const value = exact(input, ['schema', 'binding', 'model', 'modelSha256']);
        const binding = parseAuthoringInspectorBinding(value.binding);
        const model = parseAuthoringInspectorModel(value.model);
        const modelSha256 = digest(value.modelSha256);
        const controller = this.controller;
        const current = (): boolean =>
        {
            if (!controller || generation !== this.generation || !this.binding ||
                JSON.stringify(binding) !== JSON.stringify(this.binding) ||
                !inspectorBindingIsCurrent(binding, this.authority))
            {
                return false;
            }
            return generation === this.generation && this.controller === controller &&
                !controller.signal.aborted && binding.deadline > Date.now();
        };
        if (value.schema !== authoringInspectorSchema || !current() || model.sectionId !== binding.viewId ||
            model.commands.some((command) => !this.authority.commandEnabled(binding, command.commandId)))
        {
            throw new Error('Inspector result is unauthorized, stale, or contains an unavailable command.');
        }
        if (await computeAuthoringInspectorModelDigest(model) !== modelSha256 || !current())
        {
            throw new Error('Inspector content is tampered or stale.');
        }
        if (model.commands.some((command) => !this.authority.commandEnabled(binding, command.commandId)))
        {
            throw new Error('Inspector command changed during verification.');
        }
        if (!current())
        {
            throw new Error('Inspector result became stale during the final host check.');
        }
        const accepted = Object.freeze({ schema: authoringInspectorSchema, binding, model, modelSha256 });
        this.accepted = accepted;
        for (const listener of this.listeners)
        {
            listener();
        }
        if (!current())
        {
            throw new Error('Inspector result became stale during host notification.');
        }
        return accepted;
    }

    cancel(): void
    {
        const timeout = this.timeout;
        const detach = this.detach;
        const controller = this.controller;
        this.generation++;
        this.timeout = undefined;
        this.detach = undefined;
        this.controller = undefined;
        this.binding = undefined;
        this.accepted = undefined;
        if (timeout !== undefined)
        {
            clearTimeout(timeout);
        }
        detach?.();
        controller?.abort();
        for (const listener of this.listeners)
        {
            listener();
        }
    }
}
