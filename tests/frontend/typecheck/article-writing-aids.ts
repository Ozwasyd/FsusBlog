import type {
    MarkdownEditorProps,
    MarkdownEditorWritingAidsOptions
} from '@ozwasyd/element-plus';

import type { ArticleWritingAidPolicyResult } from '../../../src/frontend/src/services/authoring/articleWritingAidPolicy';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

export type ArticleWritingAidsPublicContract = [
    Expect<Equal<ArticleWritingAidPolicyResult['editorProps']['writingAids'], MarkdownEditorProps['writingAids']>>
];

const publicOptions: MarkdownEditorWritingAidsOptions = { focus: true, typewriter: true };
// @ts-expect-error Immersive belongs to the Blog shell, not FsusUI writing aids.
const immersiveOptions: MarkdownEditorWritingAidsOptions = { immersive: true };
// @ts-expect-error Surface preference is independent of writing-aid props.
const surfaceOptions: MarkdownEditorWritingAidsOptions = { mode: 'live' };

export const articleWritingAidContractControls = { publicOptions, immersiveOptions, surfaceOptions };
