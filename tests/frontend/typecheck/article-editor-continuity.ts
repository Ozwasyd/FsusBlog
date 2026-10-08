import type { MarkdownEditorDispatchResult } from '@ozwasyd/element-plus';
import {
    ArticleEditorContinuityAdapter,
    articleEditorToolEvents,
    type ArticleEditorContinuityPort,
    type ArticleEditorContinuityAcknowledgement,
    type ArticleEditorContinuityContext,
    type ArticleEditorContinuityReceipt
} from '../../../src/frontend/src/services/authoring/articleEditorContinuity';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;
type PublicContinuityContract = [
    Expect<Equal<ReturnType<ArticleEditorContinuityPort['dispatchTransaction']>, MarkdownEditorDispatchResult>>,
    Expect<Equal<ConstructorParameters<typeof ArticleEditorContinuityAdapter>[4], 'live' | 'source'>>,
    Expect<Equal<typeof articleEditorToolEvents[number], 'publish-preview-open' | 'publish-preview-close' | 'source-compare-open' | 'source-compare-close'>>,
    Expect<Equal<ArticleEditorContinuityReceipt['acknowledgement'], ArticleEditorContinuityAcknowledgement | null>>,
    Expect<Equal<ArticleEditorContinuityContext['anchor']['surface'], 'live' | 'source'>>
];
export type { PublicContinuityContract };
