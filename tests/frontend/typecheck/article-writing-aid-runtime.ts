import type { ArticleDocumentContextAdapter } from '../../../src/frontend/src/services/authoring/articleDocumentContext';
import type { ArticleEditorRuntimeBinding } from '../../../src/frontend/src/services/authoring/articleEditorRuntimeBinding';
import type {
    createArticleWritingAidRuntimeConsumer
} from '../../../src/frontend/src/services/authoring/articleWritingAidRuntime';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

export type ArticleWritingAidRealOwnerContract = [
    Expect<Equal<Parameters<typeof createArticleWritingAidRuntimeConsumer>[0], ArticleEditorRuntimeBinding>>,
    Expect<Equal<Parameters<typeof createArticleWritingAidRuntimeConsumer>[1], ArticleDocumentContextAdapter>>,
    Expect<Equal<Parameters<ReturnType<typeof createArticleWritingAidRuntimeConsumer>['resumeTypewriter']>[1], Parameters<ArticleEditorRuntimeBinding['anchors']['resume']>[0]>>
];
