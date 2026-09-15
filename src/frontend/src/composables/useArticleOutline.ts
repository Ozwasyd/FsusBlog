import {
    createMarkdownOutlineModel,
    createMarkdownOutlineTree,
    resolveMarkdownOutlineActive,
    type MarkdownEditorDocumentIdentity,
    type MarkdownEditorOutlineItem,
    type MarkdownOutlineActiveCause,
    type MarkdownOutlineActiveResult,
    type MarkdownOutlineNavigationOwner,
    type MarkdownOutlineTreeNode,
    type MarkdownOutlineViewport
} from '@/fsusui/markdownOutline';
import { shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';

/**
 * The article owns only the screen-level binding. Heading syntax, ranges and
 * stable node identities remain the FsusUI projection authority.
 */
export const articleOutlineSnapshotSchema = 'fsusblog.article-outline.v1' as const;

export interface ArticleOutlineSnapshot {
    readonly schema: typeof articleOutlineSnapshotSchema;
    readonly articleIdentity: string;
    readonly documentIdentity: MarkdownEditorDocumentIdentity;
    readonly sourceRevision: number;
    readonly items: readonly MarkdownEditorOutlineItem[];
    readonly tree: readonly MarkdownOutlineTreeNode[];
    readonly projection: ReturnType<typeof createMarkdownOutlineModel>['projection'];
}

export interface ArticleOutlineSelection {
    readonly start: number;
    readonly end: number;
    readonly direction?: 'forward' | 'backward' | 'none';
}

export interface ArticleOutlineInputs {
    readonly articleIdentity: MaybeRefOrGetter<string>;
    readonly documentIdentity: MaybeRefOrGetter<MarkdownEditorDocumentIdentity | undefined>;
    readonly source: MaybeRefOrGetter<string>;
    readonly sourceRevision: MaybeRefOrGetter<number>;
    readonly selection?: MaybeRefOrGetter<ArticleOutlineSelection | undefined>;
    readonly viewport?: MaybeRefOrGetter<MarkdownOutlineViewport | undefined>;
    readonly cause?: MaybeRefOrGetter<MarkdownOutlineActiveCause | undefined>;
    readonly owner?: MaybeRefOrGetter<MarkdownOutlineNavigationOwner | undefined>;
}

const identityKey = (identity: MarkdownEditorDocumentIdentity): string =>
    `${identity.id}\u0000${String(identity.epoch)}`;

const validIdentity = (
    identity: MarkdownEditorDocumentIdentity | undefined
): identity is MarkdownEditorDocumentIdentity =>
    identity !== undefined &&
    typeof identity.id === 'string' &&
    identity.id.length > 0 &&
    Number.isInteger(identity.epoch) &&
    identity.epoch >= 0;

const validRevision = (revision: number): boolean =>
    Number.isInteger(revision) && revision >= 0;

/** Build an article snapshot from FsusUI's canonical outline projection. */
export function createArticleOutlineSnapshot(input: {
    articleIdentity: string;
    documentIdentity: MarkdownEditorDocumentIdentity;
    source: string;
    sourceRevision: number;
    previousProjection?: ReturnType<typeof createMarkdownOutlineModel>['projection'];
}): ArticleOutlineSnapshot | null {
    if (!input.articleIdentity || !validIdentity(input.documentIdentity) ||
        !validRevision(input.sourceRevision)) {
        return null;
    }

    const model = createMarkdownOutlineModel(
        input.source,
        input.documentIdentity,
        input.previousProjection
    );

    return Object.freeze({
        schema: articleOutlineSnapshotSchema,
        articleIdentity: input.articleIdentity,
        documentIdentity: Object.freeze({ ...input.documentIdentity }),
        sourceRevision: input.sourceRevision,
        items: model.items,
        tree: createMarkdownOutlineTree(model.items),
        projection: model.projection
    });
}

export function isArticleOutlineSnapshotCurrent(
    snapshot: ArticleOutlineSnapshot | null,
    binding: {
        readonly articleIdentity: string;
        readonly documentIdentity: MarkdownEditorDocumentIdentity;
        readonly sourceRevision: number;
    }
): boolean {
    return snapshot !== null &&
        snapshot.articleIdentity === binding.articleIdentity &&
        identityKey(snapshot.documentIdentity) === identityKey(binding.documentIdentity) &&
        snapshot.sourceRevision === binding.sourceRevision;
}

export function flattenArticleOutlineTree(
    tree: readonly MarkdownOutlineTreeNode[],
    expanded: ReadonlySet<string>
): readonly MarkdownOutlineTreeNode[] {
    const result: MarkdownOutlineTreeNode[] = [];
    const visit = (nodes: readonly MarkdownOutlineTreeNode[]): void => {
        for (const node of nodes) {
            result.push(node);
            if (node.children.length > 0 && expanded.has(node.nodeId)) {
                visit(node.children);
            }
        }
    };
    visit(tree);
    return Object.freeze(result);
}

export function useArticleOutline(inputs: ArticleOutlineInputs): {
    readonly snapshot: Ref<ArticleOutlineSnapshot | null>;
    readonly active: Ref<MarkdownOutlineActiveResult | null>;
    readonly noteOutlineNavigation: (nodeId: string) => boolean;
    readonly reset: () => void;
} {
    const snapshot = shallowRef<ArticleOutlineSnapshot | null>(null);
    const active = shallowRef<MarkdownOutlineActiveResult | null>(null);
    let previousProjection: ArticleOutlineSnapshot['projection'] | undefined;
    let previousProjectionKey = '';
    let previousActive: MarkdownOutlineActiveResult | null = null;

    const syncSnapshot = (): void => {
        const documentIdentity = toValue(inputs.documentIdentity);
        const articleIdentity = toValue(inputs.articleIdentity);
        const nextKey = validIdentity(documentIdentity)
            ? `${articleIdentity}\u0000${identityKey(documentIdentity)}`
            : '';
        if (nextKey !== previousProjectionKey) {
            previousProjection = undefined;
            previousActive = null;
            active.value = null;
            previousProjectionKey = nextKey;
        }

        if (!validIdentity(documentIdentity)) {
            snapshot.value = null;
            return;
        }

        const next = createArticleOutlineSnapshot({
            articleIdentity,
            documentIdentity,
            source: toValue(inputs.source),
            sourceRevision: toValue(inputs.sourceRevision),
            previousProjection
        });
        snapshot.value = next;
        previousProjection = next?.projection;
    };

    const syncActive = (): void => {
        const current = snapshot.value;
        if (!current) {
            active.value = null;
            previousActive = null;
            return;
        }

        const selection = inputs.selection ? toValue(inputs.selection) : undefined;
        const viewport = inputs.viewport ? toValue(inputs.viewport) : undefined;
        const cause = inputs.cause ? toValue(inputs.cause) : undefined;
        const owner = inputs.owner ? toValue(inputs.owner) : undefined;
        const result = resolveMarkdownOutlineActive({
            items: current.items,
            documentId: current.documentIdentity.id,
            documentEpoch: current.documentIdentity.epoch,
            revision: current.sourceRevision,
            caret: selection?.end,
            selection,
            viewport,
            cause,
            owner,
            previous: previousActive
        });
        previousActive = result;
        active.value = result;
    };

    watch(() => [
        toValue(inputs.articleIdentity),
        toValue(inputs.documentIdentity),
        toValue(inputs.source),
        toValue(inputs.sourceRevision)
    ], () => {
        syncSnapshot();
        syncActive();
    }, { immediate: true, flush: 'sync' });

    watch(() => [
        inputs.selection ? toValue(inputs.selection) : undefined,
        inputs.viewport ? toValue(inputs.viewport) : undefined,
        inputs.cause ? toValue(inputs.cause) : undefined,
        inputs.owner ? toValue(inputs.owner) : undefined
    ], syncActive, { flush: 'sync' });

    const noteOutlineNavigation = (nodeId: string): boolean => {
        const current = snapshot.value;
        const item = current?.items.find((candidate) => candidate.nodeId === nodeId);
        if (!current || !item) {
            return false;
        }
        const result = resolveMarkdownOutlineActive({
            items: current.items,
            documentId: current.documentIdentity.id,
            documentEpoch: current.documentIdentity.epoch,
            revision: current.sourceRevision,
            caret: item.sourceRange.start,
            selection: {
                start: item.sourceRange.start,
                end: item.sourceRange.start,
                direction: 'none'
            },
            cause: 'outline',
            owner: 'outline',
            previous: null
        });
        previousActive = result;
        active.value = result;
        return result.headingId === item.nodeId;
    };

    const reset = (): void => {
        previousProjection = undefined;
        previousProjectionKey = '';
        previousActive = null;
        snapshot.value = null;
        active.value = null;
    };

    return { snapshot, active, noteOutlineNavigation, reset };
}
