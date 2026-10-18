import { describe, expect, it } from 'vitest';

import {
    applyAuthoringNavigationCommand,
    authoringNavigationCommandSchema,
    calculateAuthoringNavigationDigest,
    createAuthoringNavigationHistoryState,
    observeAuthoringNavigationTarget,
    verifyAuthoringNavigationHistoryState,
    verifyAuthoringNavigationReplay,
    verifyAuthoringNavigationTransition
} from '@/services/authoring/authoringNavigationHistory';
import type {
    AuthoringNavigationAnchor,
    AuthoringNavigationCommand,
    AuthoringNavigationHistoryState,
    AuthoringNavigationScope,
    AuthoringNavigationTransition,
    AuthoringNavigationValidity,
    AuthoringNavigationVisit
} from '@/services/authoring/authoringNavigationHistory';

const scope: AuthoringNavigationScope = {
    sessionRef: 'session:one', workspaceRef: 'workspace:one', userScope: 'user:one', siteScope: 'site:one'
};

function validity(overrides: Partial<AuthoringNavigationValidity> = {}): AuthoringNavigationValidity
{
    return { status: 'current', statusRef: 'status:one', registryRevision: 17,
        groupRegistryRevision: 5, groupRevision: 2, observationRef: 'observation:one', ...overrides };
}

function anchor(nodeId = 'node:one'): AuthoringNavigationAnchor
{
    return { nodeId, range: { start: 0, end: 1 }, affinity: 'before',
        document: { articleId: 1, draftId: 'draft:one', documentId: 'document:one', documentEpoch: 1,
            sourceRevision: 1, draftRevision: null, siteScope: scope.siteScope, userScope: scope.userScope,
            sourceIdentityDigest: 'a'.repeat(64), contentDigest: 'b'.repeat(64), contextDigest: 'c'.repeat(64) },
        anchorContextDigest: 'd'.repeat(64) };
}

function visit(sequence = 1, overrides: Partial<AuthoringNavigationVisit> = {}): AuthoringNavigationVisit
{
    return { entryId: `entry:${sequence}`, identity: { articleId: 1, draftId: 'draft:one', documentId: 'document:one' },
        documentContext: { documentEpoch: 1, sourceRevision: 'revision:one', draftRevision: null },
        anchor: null, owningGroupId: 'group:one', targetGroupId: 'group:one', cause: 'internal-link',
        userActionId: `action:${sequence}`, userSequence: sequence, userInitiatedAt: sequence * 1000,
        recordedAt: sequence * 1000, validity: validity(), recentRestore: null, ...overrides };
}

function commandBase(state: AuthoringNavigationHistoryState, sequence: number)
{
    return { schema: authoringNavigationCommandSchema, scope: state.scope, commandId: `command:${sequence}`,
        idempotencyKey: `retry:${sequence}`, commandSequence: sequence, expectedRevision: state.revision };
}

function append(state: AuthoringNavigationHistoryState, sequence: number,
    nextVisit = visit(sequence)): AuthoringNavigationCommand
{
    return { ...commandBase(state, sequence), kind: 'append', visit: nextVisit };
}

function checkedApply(state: AuthoringNavigationHistoryState, command: AuthoringNavigationCommand)
{
    const before = structuredClone(state);
    const result = applyAuthoringNavigationCommand(state, command);
    expect(state).toEqual(before);
    expect(verifyAuthoringNavigationHistoryState(result.state)).toBe(true);
    expect(verifyAuthoringNavigationTransition(state, command, result)).toBe(true);
    return result;
}

function rejected(run: () => unknown): boolean
{
    try
    {
        run();
        return false;
    }
    catch
    {
        return true;
    }
}

describe('authoring navigation closed semantic data', () =>
{
    it('preserves the original digest for ordinary dense nested data', () =>
    {
        const data = { z: [null, true, false, 0, -3, '中文', { b: 2, a: 1 }], a: [] };
        expect(calculateAuthoringNavigationDigest(data))
            .toBe('838659ab73a6337c4afd066e76c8bbbef1734ef747747ad4da0f90600e238a55');
        Object.freeze(data.z);
        Object.freeze(data);
        expect(calculateAuthoringNavigationDigest(data))
            .toBe('838659ab73a6337c4afd066e76c8bbbef1734ef747747ad4da0f90600e238a55');
    });

    it.each(['returning', 'throwing'])('rejects a %s array index getter without evaluating it', mode =>
    {
        let calls = 0;
        const values: unknown[] = ['original'];
        Object.defineProperty(values, '0', { enumerable: true, get: () =>
        {
            calls += 1;
            if (mode === 'throwing')
            {
                throw new Error('getter-executed');
            }
            return 'replacement';
        } });
        const refused = rejected(() => calculateAuthoringNavigationDigest({ values }));
        expect({ refused, calls }).toEqual({ refused: true, calls: 0 });
    });

    it('does not dispatch through an inherited array map getter', () =>
    {
        let calls = 0;
        const values = ['ordinary'];
        Object.setPrototypeOf(values, Object.create(Array.prototype, { map: { get: () =>
        {
            calls += 1;
            return Array.prototype.map;
        } } }));
        const refused = rejected(() => calculateAuthoringNavigationDigest(values));
        expect({ refused, calls }).toEqual({ refused: true, calls: 0 });
    });

    it.each(['sparse', 'symbol', 'extra'])('keeps rejecting %s array input', mode =>
    {
        const values = mode === 'sparse' ? new Array(1) : ['ordinary'];
        if (mode === 'symbol')
        {
            Object.defineProperty(values, Symbol('hidden'), { value: 'extra' });
        }
        if (mode === 'extra')
        {
            Object.defineProperty(values, 'extra', { value: 'extra' });
        }
        expect(() => calculateAuthoringNavigationDigest(values)).toThrow();
    });

    it.each(['own', 'inherited', 'throwing'])('rejects a %s command kind getter with zero calls', mode =>
    {
        const state = createAuthoringNavigationHistoryState(scope);
        const command = { ...commandBase(state, 1) };
        let calls = 0;
        const descriptor = { enumerable: true, get: () =>
        {
            calls += 1;
            if (mode === 'throwing')
            {
                throw new Error('kind-getter-executed');
            }
            return 'clear-current-session';
        } };
        if (mode === 'inherited')
        {
            Object.setPrototypeOf(command, Object.create(Object.prototype, { kind: descriptor }));
        }
        else
        {
            Object.defineProperty(command, 'kind', descriptor);
        }
        const refused = rejected(() => applyAuthoringNavigationCommand(state, command as AuthoringNavigationCommand));
        expect({ refused, calls }).toEqual({ refused: true, calls: 0 });
        expect(state.revision).toBe(0);
    });

    it.each(['toString', 'toPrimitive'])('does not coerce a command kind through %s', mode =>
    {
        const state = createAuthoringNavigationHistoryState(scope);
        let calls = 0;
        const coerce = () =>
        {
            calls += 1;
            return 'clear-current-session';
        };
        const kind = mode === 'toString' ? { toString: coerce } : { [Symbol.toPrimitive]: coerce };
        const command = { ...commandBase(state, 1), kind } as unknown as AuthoringNavigationCommand;
        const refused = rejected(() => applyAuthoringNavigationCommand(state, command));
        expect({ refused, calls }).toEqual({ refused: true, calls: 0 });
    });

    it.each(['outcome', 'affinity'])('does not coerce a nested %s enum', field =>
    {
        const state = createAuthoringNavigationHistoryState(scope);
        let calls = 0;
        const value = { toString: () =>
        {
            calls += 1;
            return field === 'outcome' ? 'completed' : 'before';
        } };
        const command = field === 'outcome'
            ? { ...commandBase(state, 1), kind: 'settle-navigation', intentRef: 'command:old', outcome: value }
            : { ...append(state, 1), visit: visit(1, { anchor: { ...anchor(), affinity: value } as unknown as AuthoringNavigationAnchor }) };
        const refused = rejected(() => applyAuthoringNavigationCommand(state, command as AuthoringNavigationCommand));
        expect({ refused, calls }).toEqual({ refused: true, calls: 0 });
    });

    it.each(['entries', 'processed'])('rejects a state %s index getter before iterating', field =>
    {
        const state = checkedApply(createAuthoringNavigationHistoryState(scope),
            append(createAuthoringNavigationHistoryState(scope), 1)).state;
        const values = [...state[field]];
        let calls = 0;
        Object.defineProperty(values, '0', { enumerable: true, get: () =>
        {
            calls += 1;
            return state[field][0];
        } });
        const accepted = verifyAuthoringNavigationHistoryState({ ...state, [field]: values });
        expect({ accepted, calls }).toEqual({ accepted: false, calls: 0 });
    });

    it.each(['commands', 'transitions'])('rejects replay %s index getters before reading', field =>
    {
        const state = createAuthoringNavigationHistoryState(scope);
        const command = append(state, 1);
        const result = checkedApply(state, command);
        let calls = 0;
        const commands = [command];
        const transitions = [result];
        Object.defineProperty(field === 'commands' ? commands : transitions, '0', { enumerable: true, get: () =>
        {
            calls += 1;
            return field === 'commands' ? command : result;
        } });
        const accepted = verifyAuthoringNavigationReplay(scope, 64, commands, transitions, result.state.contentDigest);
        expect({ accepted, calls }).toEqual({ accepted: false, calls: 0 });
    });
});

describe('authoring navigation transition compatibility', () =>
{
    it('retains route-to-anchor and rapid coalescing, CAS and retry semantics', () =>
    {
        const initial = createAuthoringNavigationHistoryState(scope);
        const firstCommand = append(initial, 1);
        const first = checkedApply(initial, firstCommand);
        const retry = checkedApply(first.state, firstCommand);
        expect(retry.receipt.status).toBe('replayed');
        expect(retry.state).toEqual(first.state);
        expect(retry.target).toBeNull();
        const conflict = checkedApply(first.state, { ...firstCommand, visit: visit(1, { recordedAt: 1001 }) } as AuthoringNavigationCommand);
        expect(conflict.receipt.status).toBe('rejected-idempotency-conflict');
        const stale = checkedApply(first.state, { ...append(first.state, 2), expectedRevision: 0 });
        expect(stale.receipt.status).toBe('rejected-cas');
        const settling = checkedApply(first.state, { ...commandBase(first.state, 2), kind: 'coalesce',
            visit: visit(1, { entryId: 'entry:settling', anchor: anchor(), recordedAt: 1100 }) });
        expect(settling.receipt.status).toBe('coalesced');
        expect(settling.state.entries).toHaveLength(1);
        expect(settling.state.entries[0].entryId).toBe('entry:1');
        expect(settling.state.lastUserSequence).toBe(1);
        expect(settling.state.lastUserInitiatedAt).toBe(1000);
        const rapid = checkedApply(settling.state, append(settling.state, 3,
            visit(2, { anchor: anchor(), userInitiatedAt: 1200, recordedAt: 1200 })));
        expect(rapid.receipt.status).toBe('coalesced');
        expect(rapid.state.entries).toHaveLength(1);
        const different = checkedApply(rapid.state, append(rapid.state, 4,
            visit(3, { anchor: anchor('node:two'), userInitiatedAt: 1400, recordedAt: 1400 })));
        expect(different.receipt.status).toBe('applied');
        expect(different.state.entries).toHaveLength(2);
    });

    it('preserves pending traversal, cancellation, branch truncation, clear and independent replay', () =>
    {
        let state = createAuthoringNavigationHistoryState(scope, 2);
        const commands: AuthoringNavigationCommand[] = [];
        const transitions: AuthoringNavigationTransition[] = [];
        const run = (command: AuthoringNavigationCommand) =>
        {
            const result = checkedApply(state, command);
            commands.push(command);
            transitions.push(result);
            state = result.state;
            return result;
        };
        run(append(state, 1));
        run(append(state, 2));
        const back = (sequence: number): AuthoringNavigationCommand => ({ ...commandBase(state, sequence), kind: 'back',
            entryId: state.entries[0].entryId, expectedEntryDigest: state.entries[0].contentDigest, validity: validity() });
        run(back(3));
        expect(state.cursor).toBe(1);
        expect(state.pending?.toCursor).toBe(0);
        expect(run(back(4)).receipt.status).toBe('rejected-pending');
        run({ ...commandBase(state, 5), kind: 'settle-navigation', intentRef: 'command:3', outcome: 'cancelled' });
        expect(state.cursor).toBe(1);
        expect(state.pending).toBeNull();
        run(back(6));
        run({ ...commandBase(state, 7), kind: 'settle-navigation', intentRef: 'command:6', outcome: 'completed' });
        expect(state.cursor).toBe(0);
        run({ ...commandBase(state, 8), kind: 'forward', entryId: state.entries[1].entryId,
            expectedEntryDigest: state.entries[1].contentDigest, validity: validity() });
        expect(run(append(state, 9, visit(3))).receipt.invalidatedIntentRef).toBe('command:8');
        expect(state.entries.map(entry => entry.entryId)).toEqual(['entry:1', 'entry:3']);
        expect(run({ ...commandBase(state, 10), kind: 'settle-navigation', intentRef: 'command:8', outcome: 'completed' })
            .receipt.status).toBe('rejected-state');
        run({ ...commandBase(state, 11), kind: 'clear-current-session' });
        expect(state.entries).toEqual([]);
        expect(state.cursor).toBe(-1);
        expect(state.lastUserSequence).toBe(3);
        expect(run(append(state, 12, visit(2))).receipt.status).toBe('rejected-sequence');
        expect(verifyAuthoringNavigationReplay(scope, 2, commands, transitions, state.contentDigest)).toBe(true);
        const tampered = structuredClone(transitions);
        tampered[0].receipt.cursorAfter = -1;
        expect(verifyAuthoringNavigationReplay(scope, 2, commands, tampered, state.contentDigest)).toBe(false);
    });

    it.each(['missing', 'deleted', 'archived', 'permission-revoked', 'stale-revision',
        'anchor-missing', 'anchor-partial', 'group-missing', 'unknown'] as const)('does not advance past a %s target', status =>
    {
        const first = checkedApply(createAuthoringNavigationHistoryState(scope),
            append(createAuthoringNavigationHistoryState(scope), 1));
        const second = checkedApply(first.state, append(first.state, 2));
        const result = checkedApply(second.state, { ...commandBase(second.state, 3), kind: 'back',
            entryId: second.state.entries[0].entryId, expectedEntryDigest: second.state.entries[0].contentDigest,
            validity: validity({ status }) });
        expect(result.receipt.status).toBe('unavailable');
        expect(result.target?.disposition).toBe('unavailable');
        expect(result.state.cursor).toBe(1);
        expect(result.state.pending).toBeNull();
    });

    it('retains producer publication ordering when a reused group has a lower local revision', () =>
    {
        const initial = createAuthoringNavigationHistoryState(scope);
        const first = checkedApply(initial, append(initial, 1));
        const lowerLocal = visit(2, { userInitiatedAt: 1200, recordedAt: 1200,
            validity: validity({ groupRegistryRevision: 9, groupRevision: 1 }) });
        const reused = checkedApply(first.state, append(first.state, 2, lowerLocal));
        expect(reused.receipt.status).toBe('coalesced');
        const samePublication = checkedApply(first.state, append(first.state, 2,
            { ...lowerLocal, validity: validity({ groupRevision: 1 }) }));
        expect(samePublication.receipt.status).toBe('rejected-state');
        const entry = first.state.entries[0];
        const facts = { current: { identity: entry.identity, documentContext: entry.documentContext,
            owningGroupId: entry.owningGroupId, status: { dirty: false, saving: false, conflict: false, recovery: false,
                pendingAttachments: false, permission: 'allowed' as const, lifecycle: 'current' as const, statusRef: 'status:one' } },
            absence: 'missing' as const, group: { groupId: entry.owningGroupId, revision: 1 },
            groupRegistry: { revision: 9, articleRegistryRevision: 17 }, anchorStatus: 'current' as const,
            anchorDocument: null, registryRevision: 17, observationRef: 'observation:reuse' };
        expect(observeAuthoringNavigationTarget(entry, facts)).toEqual(validity({ groupRegistryRevision: 9,
            groupRevision: 1, observationRef: 'observation:reuse' }));
        expect(() => observeAuthoringNavigationTarget(entry,
            { ...facts, groupRegistry: { ...facts.groupRegistry, articleRegistryRevision: 16 } })).toThrow();
    });

    it('bounds history entries and processed retry fingerprints', () =>
    {
        let state = createAuthoringNavigationHistoryState(scope, 2);
        for (let sequence = 1; sequence <= 3; sequence += 1)
        {
            state = checkedApply(state, append(state, sequence)).state;
        }
        expect(state.entries.map(entry => entry.entryId)).toEqual(['entry:2', 'entry:3']);
        for (let sequence = 4; sequence <= 260; sequence += 1)
        {
            state = applyAuthoringNavigationCommand(state, { ...commandBase(state, sequence), kind: 'clear-current-session' }).state;
        }
        expect(verifyAuthoringNavigationHistoryState(state)).toBe(true);
        expect(state.processed).toHaveLength(256);
        expect(state.processed[0].commandId).toBe('command:5');
        expect(state.lastUserSequence).toBe(3);
        expect(checkedApply(state, append(createAuthoringNavigationHistoryState(scope, 2), 1)).receipt.status).toBe('rejected-cas');
    });
});
