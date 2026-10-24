import { describe, expect, it } from 'vitest';

import {
    OpenArticleDocumentRegistry,
    calculateOpenArticleDocumentDigest,
    openArticleDocumentCommandSchema,
    openArticleDocumentRegistrySchema,
    replayOpenArticleDocumentCommands,
    verifyOpenArticleDocumentRegistryState,
    verifyOpenArticleDocumentResult,
    type ArticleDocumentIdentity,
    type ArticleWorkspaceStatusSummary,
    type OpenArticleDocumentCommand,
    type OpenOrActivateArticleCommand
} from '@/services/authoring/openArticleDocumentRegistry';

const cleanStatus: ArticleWorkspaceStatusSummary = {
    dirty: false,
    saving: false,
    conflict: false,
    recovery: false,
    pendingAttachments: false,
    permission: 'allowed',
    lifecycle: 'current',
    statusRef: 'status-clean-v1'
};

function identity(articleId: number, draftId = `draft-${articleId}`): ArticleDocumentIdentity
{
    return {
        articleId,
        draftId,
        documentId: `document-${articleId}`
    };
}

function openCommand(
    articleId: number,
    expectedRevision: number,
    overrides: Partial<OpenOrActivateArticleCommand> = {}
): OpenOrActivateArticleCommand
{
    return {
        schema: openArticleDocumentCommandSchema,
        kind: 'open-or-activate',
        commandId: `command-open-${articleId}-${expectedRevision}`,
        idempotencyKey: `idempotency-open-${articleId}-${expectedRevision}`,
        expectedRevision,
        intent: 'workspace',
        entrypoint: 'quick-switcher',
        identity: identity(articleId),
        documentContext: {
            documentEpoch: 1,
            sourceRevision: `source-${articleId}-v1`,
            draftRevision: `draft-${articleId}-v1`
        },
        editorSessionRef: `session-${articleId}-v1`,
        tabId: `tab-${articleId}-v1`,
        targetGroupId: 'group-primary',
        tabKind: 'pinned',
        status: cleanStatus,
        lastActiveAnchorRef: null,
        ...overrides
    };
}

function commandBase(kind: OpenArticleDocumentCommand['kind'], revision: number)
{
    return {
        schema: openArticleDocumentCommandSchema,
        kind,
        commandId: `command-${kind}-${revision}`,
        idempotencyKey: `idempotency-${kind}-${revision}`,
        expectedRevision: revision
    } as const;
}

describe('OpenArticleDocumentRegistry contract (#2293)', () => {
    it.each([
        'rail',
        'quick-switcher',
        'internal-link',
        'recent-restore',
        'direct-route'
    ] as const)('uses the same open-or-activate command for the %s entrypoint', entrypoint => {
        const registry = new OpenArticleDocumentRegistry();
        const first = registry.execute(openCommand(91, 0, { entrypoint }));
        const second = registry.execute(openCommand(91, 1, {
            commandId: `command-repeat-${entrypoint}`,
            idempotencyKey: `idempotency-repeat-${entrypoint}`,
            entrypoint,
            targetGroupId: 'group-secondary'
        }));

        expect(first.status).toBe('applied');
        expect(second.status).toBe('activated-existing');
        expect(second.tabId).toBe(first.tabId);
        expect(second.editorSessionRef).toBe(first.editorSessionRef);
        expect(second.owningGroupId).toBe('group-primary');
        expect(registry.listEntries()).toHaveLength(1);
    });

    it('opens or activates one stable article identity without moving or cloning it', () => {
        const registry = new OpenArticleDocumentRegistry();
        const opened = registry.openOrActivate(openCommand(101, 0, {
            targetGroupId: 'group-secondary'
        }));

        expect(opened.status).toBe('applied');
        expect(opened.entryAfter?.schema).toBe('fsusblog.open-article-document-entry.v1');
        expect(opened.entryAfter?.owningGroupId).toBe('group-secondary');
        expect(opened.entryAfter?.editorSessionRef).toBe('session-101-v1');

        const activated = registry.openOrActivate(openCommand(101, 1, {
            commandId: 'command-open-existing-101',
            idempotencyKey: 'idempotency-open-existing-101',
            editorSessionRef: 'session-should-not-replace',
            tabId: 'tab-should-not-replace',
            targetGroupId: 'group-primary',
            lastActiveAnchorRef: 'anchor-existing-101'
        }));

        expect(activated.status).toBe('activated-existing');
        expect(activated.entryBefore?.owningGroupId).toBe('group-secondary');
        expect(activated.entryAfter?.tabId).toBe('tab-101-v1');
        expect(activated.entryAfter?.editorSessionRef).toBe('session-101-v1');
        expect(activated.entryAfter?.owningGroupId).toBe('group-secondary');
        expect(activated.entryAfter?.lastActiveAnchorRef).toBe('anchor-existing-101');
        expect(registry.listEntries()).toHaveLength(1);
        expect(verifyOpenArticleDocumentRegistryState(registry.exportState())).toBe(true);
    });

    it('excludes browser new-tab navigation and rejects stale CAS or changed idempotent retries', () => {
        const registry = new OpenArticleDocumentRegistry();
        const browserCommand = openCommand(102, 0, {
            intent: 'browser-new-tab'
        });

        expect(registry.execute(browserCommand).status).toBe('ignored-browser-new-tab');
        expect(registry.getRevision()).toBe(0);
        expect(registry.listEntries()).toHaveLength(0);
        expect(registry.execute(browserCommand).status).toBe('ignored-browser-new-tab');
        expect(registry.exportState().processedCommandDigests).toHaveLength(0);

        const applied = openCommand(104, 0);
        expect(registry.execute(applied).status).toBe('applied');
        expect(registry.execute(applied).status).toBe('replayed');
        expect(registry.execute({
            ...applied,
            targetGroupId: 'group-secondary'
        }).status).toBe('rejected-idempotency-conflict');

        const stale = openCommand(103, 4);
        expect(registry.execute(stale).status).toBe('rejected-cas');
        expect(registry.listEntries()).toHaveLength(1);
    });

    it('replaces only a safe preview and always assigns the new article its own tab and session refs', () => {
        const registry = new OpenArticleDocumentRegistry();
        const first = registry.execute(openCommand(201, 0, {
            tabKind: 'preview'
        }));
        const secondCommand = openCommand(202, 1, {
            tabKind: 'preview'
        });
        const second = registry.execute(secondCommand);

        expect(second.status).toBe('applied');
        expect(second.replacedPreviewTabId).toBe(first.tabId);
        expect(second.replacedPreviewSessionRef).toBe(first.editorSessionRef);
        expect(second.tabId).toBe('tab-202-v1');
        expect(second.editorSessionRef).toBe('session-202-v1');
        expect(registry.getEntryByIdentity(identity(201))).toBeNull();

        const riskyStatus = {
            ...cleanStatus,
            dirty: true,
            statusRef: 'status-dirty-202'
        };
        const marked = registry.execute({
            ...commandBase('mark-status', 2),
            tabId: 'tab-202-v1',
            status: riskyStatus
        });
        expect(marked.entryAfter?.isPinned).toBe(true);
        expect(marked.entryAfter?.isPreview).toBe(false);

        const third = registry.execute(openCommand(203, 3, {
            tabKind: 'preview'
        }));
        expect(third.status).toBe('applied');
        expect(third.replacedPreviewTabId).toBeNull();
        expect(registry.listEntries()).toHaveLength(2);
    });

    it('promotes a preview through the explicit pin command and rejects unsafe unpinning', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(211, 0, {
            tabKind: 'preview'
        }));

        const pinned = registry.execute({
            ...commandBase('set-pin-state', 1),
            tabId: 'tab-211-v1',
            pinned: true
        });
        expect(pinned.entryAfter?.isPinned).toBe(true);
        expect(pinned.entryAfter?.isPreview).toBe(false);

        registry.execute({
            ...commandBase('mark-status', 2),
            tabId: 'tab-211-v1',
            status: {
                ...cleanStatus,
                pendingAttachments: true,
                statusRef: 'status-pending-211'
            }
        });
        const unsafeUnpin = registry.execute({
            ...commandBase('set-pin-state', 3),
            commandId: 'command-set-pin-state-unsafe',
            idempotencyKey: 'idempotency-set-pin-state-unsafe',
            tabId: 'tab-211-v1',
            pinned: false
        });
        expect(unsafeUnpin.status).toBe('rejected-preview-risk');
    });

    it.each([
        ['dirty', { dirty: true }],
        ['saving', { saving: true }],
        ['conflict', { conflict: true }],
        ['recovery', { recovery: true }],
        ['pending attachment', { pendingAttachments: true }]
    ])('promotes an initially %s preview instead of making it replaceable', (_label, changedStatus) => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(301, 0, {
            tabKind: 'preview',
            status: {
                ...cleanStatus,
                ...changedStatus,
                statusRef: 'status-risky-preview'
            }
        }));

        const next = registry.execute(openCommand(302, 1, {
            tabKind: 'preview'
        }));
        expect(next.status).toBe('applied');
        expect(registry.getEntryByIdentity(identity(301))).not.toBeNull();
        expect(registry.getEntryByIdentity(identity(301))?.isPinned).toBe(true);
        expect(registry.getEntryByIdentity(identity(302))).not.toBeNull();
        expect(registry.listEntries()).toHaveLength(2);
    });

    it('keeps same-source articles isolated by stable article, draft, document, tab and session identities', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(401, 0, {
            documentContext: {
                documentEpoch: 2,
                sourceRevision: 'shared-source-revision',
                draftRevision: 'draft-401-v2'
            }
        }));
        registry.execute(openCommand(402, 1, {
            documentContext: {
                documentEpoch: 2,
                sourceRevision: 'shared-source-revision',
                draftRevision: 'draft-402-v2'
            }
        }));

        const entries = registry.listEntries();
        expect(entries).toHaveLength(2);
        expect(new Set(entries.map(entry => entry.editorSessionRef)).size).toBe(2);
        expect(new Set(entries.map(entry => entry.identity.documentId)).size).toBe(2);
        expect(new Set(entries.map(entry => entry.contentDigest)).size).toBe(2);
    });

    it('rejects duplicate tab and session ownership without changing the accepted article', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(451, 0));

        const duplicateTab = registry.execute(openCommand(452, 1, {
            tabId: 'tab-451-v1'
        }));
        expect(duplicateTab.status).toBe('rejected-duplicate-identity');

        const duplicateSession = registry.execute(openCommand(453, 1, {
            editorSessionRef: 'session-451-v1'
        }));
        expect(duplicateSession.status).toBe('rejected-duplicate-session');
        expect(registry.listEntries().map(entry => entry.identity.articleId)).toEqual([451]);
    });

    it('requires a formal close request before detach and protects a requested preview from replacement', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(471, 0, {
            tabKind: 'preview'
        }));

        const earlyDetach = registry.execute({
            ...commandBase('detach-on-final-close', 1),
            tabId: 'tab-471-v1',
            closeDecisionRef: 'verified-close-decision-471'
        });
        expect(earlyDetach.status).toBe('rejected-state');

        registry.execute({
            ...commandBase('request-close', 1),
            tabId: 'tab-471-v1'
        });
        const replacement = registry.execute(openCommand(472, 2, {
            tabKind: 'preview'
        }));
        expect(replacement.status).toBe('rejected-preview-risk');
        expect(registry.getEntryByIdentity(identity(471))).not.toBeNull();
    });

    it('applies the closed command set with CAS and retains invalidated articles until final close', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(501, 0));

        const permission = registry.execute({
            ...commandBase('invalidate-permission', 1),
            tabId: 'tab-501-v1',
            permission: 'revoked',
            statusRef: 'permission-revoked-501'
        });
        expect(permission.entryAfter?.status.permission).toBe('revoked');
        expect(registry.listEntries()).toHaveLength(1);

        const activateBlocked = registry.execute({
            ...commandBase('activate', 2),
            tabId: 'tab-501-v1',
            lastActiveAnchorRef: null
        });
        expect(activateBlocked.status).toBe('rejected-state');

        const lifecycle = registry.execute({
            ...commandBase('invalidate-lifecycle', 2),
            tabId: 'tab-501-v1',
            lifecycle: 'deleted',
            statusRef: 'lifecycle-deleted-501'
        });
        expect(lifecycle.entryAfter?.status.lifecycle).toBe('deleted');
        expect(registry.listEntries()).toHaveLength(1);

        const closeRequest = registry.execute({
            ...commandBase('request-close', 3),
            tabId: 'tab-501-v1'
        });
        expect(closeRequest.entryAfter?.closeRequestRef).toBe('command-request-close-3');

        const detached = registry.execute({
            ...commandBase('detach-on-final-close', 4),
            tabId: 'tab-501-v1',
            closeDecisionRef: 'verified-close-decision-501'
        });
        expect(detached.status).toBe('applied');
        expect(registry.listEntries()).toHaveLength(0);
    });

    it('changes draft and group ownership only through explicit commands', () => {
        const registry = new OpenArticleDocumentRegistry();
        registry.execute(openCommand(601, 0));

        const replaced = registry.execute({
            ...commandBase('replace-draft-identity', 1),
            tabId: 'tab-601-v1',
            draftId: 'draft-601-v2',
            draftRevision: 'draft-revision-601-v2',
            replacementRef: 'draft-replacement-601-v2'
        });
        expect(replaced.entryAfter?.identity.draftId).toBe('draft-601-v2');
        expect(replaced.entryAfter?.editorSessionRef).toBe('session-601-v1');
        expect(replaced.authorityRef).toBe('draft-replacement-601-v2');

        const moved = registry.execute({
            ...commandBase('update-group-ownership', 2),
            tabId: 'tab-601-v1',
            targetGroupId: 'group-secondary',
            ownershipTransactionRef: 'group-transaction-601-v1'
        });
        expect(moved.entryBefore?.owningGroupId).toBe('group-primary');
        expect(moved.entryAfter?.owningGroupId).toBe('group-secondary');
        expect(moved.entryAfter?.tabId).toBe('tab-601-v1');
        expect(moved.entryAfter?.editorSessionRef).toBe('session-601-v1');
        expect(moved.authorityRef).toBe('group-transaction-601-v1');
    });

    it('fails closed for route, title, hash, index, body, undo and unknown command fields', () => {
        const registry = new OpenArticleDocumentRegistry();
        const valid = openCommand(701, 0);
        for (const [field, value] of [
            ['route', '/admin/article/write?id=701'],
            ['title', 'Identity by title'],
            ['sourceHash', 'identity-by-hash'],
            ['arrayIndex', 0],
            ['markdownBody', '# copied body'],
            ['undoStack', ['copied-history']]
        ] as const)
        {
            const mutated = {
                ...valid,
                commandId: `command-invalid-${field}`,
                idempotencyKey: `idempotency-invalid-${field}`,
                [field]: value
            };
            expect(registry.execute(mutated).status).toBe('rejected-invalid-command');
        }
        expect(registry.listEntries()).toHaveLength(0);
    });

    it('detects entry, state, receipt and cardinality tampering and independently replays commands', () => {
        const commands: OpenArticleDocumentCommand[] = [
            openCommand(801, 0),
            openCommand(802, 1)
        ];
        const replay = replayOpenArticleDocumentCommands(commands);
        expect(replay.accepted).toBe(true);
        expect(replay.failingCommandIndex).toBeNull();
        expect(replay.results.every(verifyOpenArticleDocumentResult)).toBe(true);
        expect(replay.state.schema).toBe(openArticleDocumentRegistrySchema);

        const entryTamper = structuredClone(replay.state);
        entryTamper.entries[0].owningGroupId = 'group-tampered';
        expect(verifyOpenArticleDocumentRegistryState(entryTamper)).toBe(false);

        const duplicateIdentity = structuredClone(replay.state);
        duplicateIdentity.entries[1].identity = structuredClone(duplicateIdentity.entries[0].identity);
        const secondEntryBase = { ...duplicateIdentity.entries[1] };
        delete (secondEntryBase as Partial<typeof secondEntryBase>).contentDigest;
        duplicateIdentity.entries[1].contentDigest = calculateOpenArticleDocumentDigest(secondEntryBase);
        const stateBase = { ...duplicateIdentity };
        delete (stateBase as Partial<typeof stateBase>).contentDigest;
        duplicateIdentity.contentDigest = calculateOpenArticleDocumentDigest(stateBase);
        expect(verifyOpenArticleDocumentRegistryState(duplicateIdentity)).toBe(false);

        const resultTamper = {
            ...replay.results[0],
            editorSessionRef: 'session-tampered'
        };
        expect(verifyOpenArticleDocumentResult(resultTamper)).toBe(false);
    });
});
