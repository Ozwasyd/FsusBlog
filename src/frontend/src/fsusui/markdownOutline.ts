/**
 * FsusUI outline authority for Blog consumers.
 *
 * Keep runtime imports at this adapter boundary so article surfaces consume
 * the public projection/reveal contract without reaching into FsusUI internals.
 */
export {
    createMarkdownOutlineModel,
    createMarkdownOutlineTree,
    resolveMarkdownOutlineActive
} from '@ozwasyd/element-plus';
export { createMarkdownSourceCoordinateMap } from '@ozwasyd/element-plus/markdown-runtime';
export type {
    MarkdownEditorDocumentIdentity,
    MarkdownEditorOutlineItem,
    MarkdownOutlineActiveCause,
    MarkdownOutlineActiveResult,
    MarkdownOutlineNavigationOwner,
    MarkdownOutlineTreeNode,
    MarkdownOutlineViewport
} from '@ozwasyd/element-plus';
