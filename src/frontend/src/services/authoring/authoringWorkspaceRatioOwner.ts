const scopeBrand: unique symbol = Symbol('authoring-workspace-ratio-scope');
const ratioBrand: unique symbol = Symbol('authoring-workspace-ratio-ref');
const changeBrand: unique symbol = Symbol('authoring-workspace-ratio-change');

/** Matches the existing Shared snapshot validator and default, not a new wire contract. */
export const authoringWorkspaceRatioPolicy = Object.freeze({
    schema: 'fsusblog.authoring-workspace-ratio-policy.v1',
    minimumPermille: 200,
    maximumPermille: 800,
    defaultPermille: 500,
    lifetime: 'workspace-in-current-session',
    persistence: 'none'
} as const);

/** Process-local workspace lifetime capability. Never serialize or reconstruct it from an ID. */
export interface AuthoringWorkspaceRatioScope {
    readonly [scopeBrand]: true;
}

/** Only this owner issues refs; structural copies and arbitrary strings have no authority. */
export interface AuthoringWorkspaceRatioRef {
    readonly [ratioBrand]: true;
}

/** A staged ref is not current until commit succeeds against its exact predecessor. */
export interface AuthoringWorkspaceRatioChange {
    readonly [changeBrand]: true;
    readonly ratioRef: AuthoringWorkspaceRatioRef;
}

export interface AuthoringWorkspaceRatioObservation {
    readonly ratioRef: AuthoringWorkspaceRatioRef;
    readonly revision: number;
    readonly splitRatioPermille: number;
}

/** Pre-publication observation for the original group transaction; not a current ref. */
export interface AuthoringWorkspacePreparedRatioObservation extends AuthoringWorkspaceRatioObservation {
    readonly expectedRatioRef: AuthoringWorkspaceRatioRef;
}

interface RatioState {
    current: AuthoringWorkspaceRatioRef;
    revision: number;
}

interface RatioValue {
    readonly scope: AuthoringWorkspaceRatioScope;
    readonly revision: number;
    readonly splitRatioPermille: number;
}

interface PreparedRatioValue {
    readonly scope: AuthoringWorkspaceRatioScope;
    readonly expected: AuthoringWorkspaceRatioRef;
    readonly next: AuthoringWorkspaceRatioRef;
}

export class AuthoringWorkspaceRatioError extends Error
{
    public readonly reason: 'invalid-scope' | 'invalid-ratio' | 'invalid-change' | 'stale-ratio' | 'revision-exhausted';

    public constructor(reason: AuthoringWorkspaceRatioError['reason'])
    {
        super(reason);
        this.name = 'AuthoringWorkspaceRatioError';
        this.reason = reason;
    }
}

/** Reject invalid restore/input values; clamping belongs only to admitted geometry or gestures. */
export function isAuthoringWorkspaceRatioPermille(value: unknown): value is number
{
    return typeof value === 'number' && Number.isInteger(value)
        && value >= authoringWorkspaceRatioPolicy.minimumPermille
        && value <= authoringWorkspaceRatioPolicy.maximumPermille;
}

// The class is not exported; ECMAScript # members seal the actual state/issuance boundary.
class AuthoringWorkspaceRatioOwner
{
    readonly #scopes = new WeakMap<AuthoringWorkspaceRatioScope, RatioState>();
    readonly #ratios = new WeakMap<AuthoringWorkspaceRatioRef, RatioValue>();
    readonly #changes = new WeakMap<AuthoringWorkspaceRatioChange, PreparedRatioValue>();

    /** Called once by the real workspace lifecycle owner, never on collapse or group merge. */
    public openWorkspace(): AuthoringWorkspaceRatioScope
    {
        const scope = Object.freeze({ [scopeBrand]: true as const });
        const current = this.#issue(scope, 0, authoringWorkspaceRatioPolicy.defaultPermille);
        this.#scopes.set(scope, { current, revision: 0 });
        return scope;
    }

    /** Retrieves the owner's current ref, for workspace bootstrap or an explicit source observation. */
    public read(scope: AuthoringWorkspaceRatioScope): AuthoringWorkspaceRatioObservation
    {
        return this.resolve(scope, this.#requireScope(scope).current);
    }

    /** Projection consumers must pass their exact ref; missing/foreign/staged refs fail closed. */
    public resolve(scope: AuthoringWorkspaceRatioScope, ratioRef: AuthoringWorkspaceRatioRef): AuthoringWorkspaceRatioObservation
    {
        const state = this.#requireScope(scope);
        const current = ratioRef;
        if (current !== state.current)
        {
            throw new AuthoringWorkspaceRatioError('stale-ratio');
        }
        const value = this.#ratios.get(current);
        if (value?.scope !== scope || value.revision !== state.revision)
        {
            throw new AuthoringWorkspaceRatioError('stale-ratio');
        }
        return Object.freeze({ ratioRef: current, revision: value.revision, splitRatioPermille: value.splitRatioPermille });
    }

    /**
     * Snapshot applyGroups stages its validated splitRatioPermille here, then passes ratioRef
     * to the real group transaction. Preparation publishes nothing and creates no group.
     */
    public prepare(scope: AuthoringWorkspaceRatioScope, expected: AuthoringWorkspaceRatioRef, splitRatioPermille: number): AuthoringWorkspaceRatioChange
    {
        const observation = this.resolve(scope, expected);
        if (!isAuthoringWorkspaceRatioPermille(splitRatioPermille))
        {
            throw new AuthoringWorkspaceRatioError('invalid-ratio');
        }
        if (observation.revision === Number.MAX_SAFE_INTEGER)
        {
            throw new AuthoringWorkspaceRatioError('revision-exhausted');
        }
        const next = this.#issue(scope, observation.revision + 1, splitRatioPermille);
        const change = Object.freeze({ [changeBrand]: true as const, ratioRef: next });
        this.#changes.set(change, Object.freeze({ scope, expected, next }));
        return change;
    }

    /** Lets the real group owner validate its staged ref/value while both current states remain unchanged. */
    public readPrepared(scope: AuthoringWorkspaceRatioScope, change: AuthoringWorkspaceRatioChange): AuthoringWorkspacePreparedRatioObservation
    {
        this.#requireScope(scope);
        const prepared = this.#changes.get(change);
        if (prepared?.scope !== scope || prepared.next !== change.ratioRef)
        {
            throw new AuthoringWorkspaceRatioError('invalid-change');
        }
        this.resolve(scope, prepared.expected);
        const value = this.#ratios.get(prepared.next)!;
        return Object.freeze({ expectedRatioRef: prepared.expected, ratioRef: prepared.next,
            revision: value.revision, splitRatioPermille: value.splitRatioPermille });
    }

    /**
     * Synchronous exact-ref CAS. The group integration must pre-stage all fallible work
     * and publish both owners without callbacks/await; that transaction is not supplied here.
     */
    public commit(scope: AuthoringWorkspaceRatioScope, change: AuthoringWorkspaceRatioChange): AuthoringWorkspaceRatioObservation
    {
        const state = this.#requireScope(scope);
        const prepared = this.#changes.get(change);
        if (prepared?.scope !== scope || prepared.next !== change.ratioRef)
        {
            throw new AuthoringWorkspaceRatioError('invalid-change');
        }
        if (state.current !== prepared.expected)
        {
            this.#changes.delete(change);
            throw new AuthoringWorkspaceRatioError('stale-ratio');
        }
        const value = this.#ratios.get(prepared.next)!;
        const observation = Object.freeze({ ratioRef: prepared.next, revision: value.revision, splitRatioPermille: value.splitRatioPermille });
        this.#scopes.set(scope, { current: prepared.next, revision: value.revision });
        this.#changes.delete(change);
        return observation;
    }

    /** A refused/cancelled group transaction discards its proposal without changing current ratio. */
    public discard(scope: AuthoringWorkspaceRatioScope, change: AuthoringWorkspaceRatioChange): void
    {
        this.#requireScope(scope);
        const prepared = this.#changes.get(change);
        if (prepared?.scope !== scope)
        {
            throw new AuthoringWorkspaceRatioError('invalid-change');
        }
        this.#changes.delete(change);
    }

    /** Logout/site switch/workspace disposal revokes all refs and pending changes in this scope. */
    public releaseWorkspace(scope: AuthoringWorkspaceRatioScope): void
    {
        this.#requireScope(scope);
        this.#scopes.delete(scope);
    }

    #requireScope(scope: AuthoringWorkspaceRatioScope): RatioState
    {
        const state = this.#scopes.get(scope);
        if (!state)
        {
            throw new AuthoringWorkspaceRatioError('invalid-scope');
        }
        return state;
    }

    #issue(scope: AuthoringWorkspaceRatioScope, revision: number, splitRatioPermille: number): AuthoringWorkspaceRatioRef
    {
        const ratioRef = Object.freeze({ [ratioBrand]: true as const });
        this.#ratios.set(ratioRef, Object.freeze({ scope, revision, splitRatioPermille }));
        return ratioRef;
    }
}

export const authoringWorkspaceRatioOwner = Object.freeze(new AuthoringWorkspaceRatioOwner());
