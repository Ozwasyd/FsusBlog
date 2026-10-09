import { expect, it } from 'vitest';

import { ElAutoResizer, ElButton, ElCheckbox, ElDrawer, ElOption, ElRadio, ElRadioGroup, ElSelect, ElSelectV2, ElTableV2 } from '@ozwasyd/element-plus';
import { FsusUiButton } from '@/fsusui/button';
import { FsusUiClassicOption, FsusUiClassicSelect } from '@/fsusui/classicSelect';
import {
    FsusUiExportAutoResizer, FsusUiExportCheckbox, FsusUiExportDrawer, FsusUiExportRadio,
    FsusUiExportRadioGroup, FsusUiExportTableV2
} from '@/fsusui/documentExportControls';

it.each([
    ['auto resizer', FsusUiExportAutoResizer, ElAutoResizer], ['button', FsusUiButton, ElButton],
    ['checkbox', FsusUiExportCheckbox, ElCheckbox], ['drawer', FsusUiExportDrawer, ElDrawer],
    ['classic option', FsusUiClassicOption, ElOption], ['radio', FsusUiExportRadio, ElRadio],
    ['radio group', FsusUiExportRadioGroup, ElRadioGroup], ['classic select', FsusUiClassicSelect, ElSelect],
    ['virtual table', FsusUiExportTableV2, ElTableV2]
])('retains actual upstream runtime object identity for %s', (_name, adapter, upstream) => {
    expect(adapter).toBe(upstream); expect(adapter).toBeTruthy();
});
it('keeps the existing classic select distinct from V2 without a compatibility wrapper', () => {
    expect(FsusUiClassicSelect).not.toBe(ElSelectV2);
});
