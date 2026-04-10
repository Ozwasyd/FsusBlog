export type UiActionContract = Readonly<{
  action: string;
  value?: number;
}>;

export type ButtonVariant = 'plain' | 'quiet' | 'primary';

export type ButtonContract = Readonly<{
  label: string;
  variant: ButtonVariant;
  disabled?: boolean;
  ariaLabel?: string;
  href?: string;
  action?: UiActionContract;
}>;

export type TagContract = Readonly<{
  label: string;
  hiddenOnMobile?: boolean;
}>;

export type EmptyStateContract = Readonly<{
  title: string;
  body?: string;
  action?: ButtonContract;
}>;

export type PaginationContract = Readonly<{
  previous: ButtonContract;
  next: ButtonContract;
  indicator: string;
}>;

export type CardContract = Readonly<{
  kind: 'article-list-card';
  index?: number;
}>;
