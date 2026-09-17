export type UiActionContract = Readonly<{
    action: string;
    value?: number;
}>;

export type TagVariant = 'ghost' | 'badge' | 'status';
export type TagTone = 'neutral' | 'info' | 'success' | 'danger' | 'warning';

export type PaginationContract = Readonly<{
    previous: Readonly<{
        label: string;
        href?: string;
        disabled?: boolean;
        action?: UiActionContract;
    }>;
    next: Readonly<{
        label: string;
        href?: string;
        disabled?: boolean;
        action?: UiActionContract;
    }>;
    indicator: string;
}>;

export type CardContract = Readonly<{
    kind: 'article-list-card';
    index?: number;
}>;
