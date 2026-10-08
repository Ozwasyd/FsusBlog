import ArticleCommentComposer from '../../../src/frontend/src/components/article/ArticleCommentComposer.vue'
import { FsusUiCheckbox, type FsusUiCheckboxValue } from '../../../src/frontend/src/fsusui/checkbox'
import { FsusUiInput, type FsusUiInputInstance } from '../../../src/frontend/src/fsusui/input'
import { FsusUiSegmentedControl, type FsusUiSegmentedControlItem } from '../../../src/frontend/src/fsusui/segmentedControl'

const modes: FsusUiSegmentedControlItem[] = [
    { value: 'write', label: '编写' },
    { value: 'preview', label: '预览' }
]
const publicChoice: FsusUiCheckboxValue = false
const restoreSelection = (editor: FsusUiInputInstance): void => {
    editor.focus()
    editor.textarea?.setSelectionRange(1, 3, 'backward')
}

export const articleCommentComposerConsumerContract = {
    ArticleCommentComposer,
    FsusUiCheckbox,
    FsusUiInput,
    FsusUiSegmentedControl,
    modes,
    publicChoice,
    restoreSelection
}
