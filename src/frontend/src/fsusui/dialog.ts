export { ElDialog as FsusUiDialog } from '@ozwasyd/element-plus';
export type { DialogBeforeCloseFn as FsusUiDialogBeforeCloseFn } from '@ozwasyd/element-plus';

export const fsusDialogWidths = {
    default: '50%',
    compact: 'min(92vw, 28rem)',
    extraCompact: 'min(92vw, 24rem)',
    longForm: 'min(92vw, 48rem)'
} as const;

export type FsusDialogWidth = (typeof fsusDialogWidths)[keyof typeof fsusDialogWidths];

export const isFsusDialogWidth = (value: string): value is FsusDialogWidth =>
    Object.values(fsusDialogWidths).includes(value as FsusDialogWidth);
