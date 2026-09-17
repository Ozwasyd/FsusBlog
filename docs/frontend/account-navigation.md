# Account navigation

Identity and admin use the same two-level navigation component while keeping separate data and authorization boundaries. The persistent level shows modules; the local level shows only destinations in the active module. Route path, rather than a second navigation store, determines both current states.

## Surface separation

The self-service surface exposes only identity/account modules and self-service leaves. It cannot contain `/user/manage` destinations. The admin surface receives permission-, feature- and policy-filtered groups from its own workspace context; its six-module taxonomy and leaf responsibilities are defined only in [Admin information architecture](admin-information-architecture.md).

Desktop renders all visible modules plus the active module's leaves in a sticky rail. Mobile reuses that data in exactly one Drawer. Module and local navigation have distinct labels and `aria-current` values; both mobile link levels retain a 44px minimum target. Desktop local links use the compact 40px tier. The local section is indented one spacing step beyond the module list, and active state is identified by the primary two-pixel edge rather than hover styling.

## Page titles

Every account route exposes one task-oriented H1 through the canonical task-page header. Page components supply title and description content; the shared account CSS may own only header-to-content composition spacing, not a second title implementation. Identity and admin pages may use different content frames, but neither creates a competing responsive H1 scale.

Navigation labels use the current compact hierarchy: 11px bold uppercase group labels, 13px/500 inactive module and local labels, and 13px/700 active labels. These values are guarded by the account density contract; removed issue records are not typography baselines.

## Header actions

Shared desktop chrome contains brand, Main-site switch, theme, the shared catalog-backed ten-language selector (`LocaleSelectorRuntimeAdapter`), and account-menu actions. Account and admin share the same chrome entry; layouts only choose slot placement and the compact prop, and must not import locale runtime, catalog, bundle store, Cookie, or preference APIs. Explicit auto/fixed preference editing lives at `/user/preferences/language` in the self-surface nav, not in admin system settings. The bordered action family uses the compact 40px control height. Mobile uses the 44px control tier and additionally exposes the single Drawer trigger with `aria-controls` and `aria-expanded`.

The account menu owns account/admin surface switching when authorized, usage guidelines, privacy policy and logout. Logout keeps its loading/disabled state. An identity-only principal never receives a management switch. The header does not duplicate local navigation, page actions or dashboard tasks.

## URL and accessibility continuity

- Existing URLs and named leaf routes remain authoritative for refresh, deep links and browser history.
- Prefix-sensitive admin destinations select exactly one local leaf.
- Opening and closing the mobile Drawer preserves its focus trap and returns focus through the shared component contract.
- Forced-colors focus outlines remain visible, and persistent action borders reserve their geometry across hover/open states.

Frame and scroll responsibility is defined in [Account layout ownership](account-layout-ownership.md). CSS selector ownership is defined in [Account style ownership](account-style-ownership.md). Visual change classification is referenced, not duplicated, from [Layout visual governance](layout-visual-governance.md).
