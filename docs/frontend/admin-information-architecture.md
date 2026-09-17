# Admin information architecture

The account shell separates persistent modules from module-local destinations. It does not flatten every admin route into the desktop sidebar.

This document owns the admin module taxonomy, leaf responsibility and filtering semantics. Shared identity/admin frame geometry, navigation rendering, CSS and motion are defined by [Account layout ownership](account-layout-ownership.md), [Account navigation](account-navigation.md), [Account style ownership](account-style-ownership.md) and [Account motion](account-motion.md).

## Persistent modules

A fully authorized admin sees six first-level modules, below the hard limit of seven:

| Module | Landing route | Local responsibility |
| --- | --- | --- |
| `工作台` (Workbench) | `/user/manage` | today’s operational tasks |
| `内容` (Content) | `/user/manage/article/list` | articles, trash, taxonomy, tags and assets |
| `互动` (Interaction) | `/user/manage/moderation` | moderation, messages, users and anonymous-comment governance |
| `安全` (Security) | `/user/manage/security` | risk controls and challenge systems |
| `系统` (System) | `/user/manage/settings` | settings, backup/migration and audit |
| `运维` (Operations) | `/user/manage/analytics` | analytics, service health, cache and integrity |

The appearance/customization admin shell remains an internal workspace of system settings. It is not a seventh global navigation system and does not own global IA.

## Permission and feature filtering

`getAccountNavGroups` filters every leaf before creating its module. A module with no visible leaves is omitted entirely; unavailable destinations are not rendered as disabled links.

The filtering inputs remain the existing contract:

- active admin principal (`canManage`);
- exact permission strings;
- anonymous-comment feature flags;
- anonymous-governance policy gates.

The module landing destination is the preferred leaf when it is authorized, otherwise the first authorized leaf. For example, an audit-only principal sees one System module whose landing route is `/user/manage/audit`.

No permission name, route URL, redirect, or backend authorization behavior changes as part of this IA.

## Current context and deep links

Global module current state and local leaf current state derive from `route.path` on every render. Direct refresh, a copied deep link, browser back, and browser forward therefore restore the same context without keeping a second navigation history.

Prefix-sensitive routes have explicit matching:

- article create/edit/list select the Article leaf;
- nested security routes select the Security module;
- anonymous-governance pages select their exact Interaction leaf rather than the general moderation leaf;
- `/user/manage/integrity-proof` does not collide with `/user/manage/integrity`;
- `/user/manage` matches only the workbench root.

Security and moderation retain their existing internal section navigation. The account shell provides module context; those nested workspaces continue to own their deeper subpages.

The security workspace uses its top-level `AdminSystemTabs` as the single complete
security navigation authority. `/user/manage/security` does not repeat those
destinations as a card directory. Its dashboard is an operational view ordered as:
current status, actionable anomalies, key trends and recent policy changes.
Anomaly rows may link directly to the relevant subsystem because those links are
contextual next actions, not a second navigation taxonomy. When no anomaly exists,
the dashboard renders one compact healthy summary rather than one normal-state
card per subsystem.

## Desktop behavior

The desktop rail renders the six module links and only the active module’s local leaves. It is sticky but has no internal `overflow-y` scroll container. A regular 768px-high viewport therefore does not acquire a scrollbar merely because unrelated modules contain more pages.

The content column keeps its independent scrolling behavior so long forms, tables and takeover pages retain their existing layout.

## Mobile behavior

Mobile uses one Element Plus Drawer for both levels:

1. all visible first-level modules;
2. only the current module’s visible local leaves.

The trigger and Drawer title expose the current module and page. Module and local links retain 44px minimum targets, distinct navigation labels, `aria-current` state, the existing motion preset and Drawer focus trap. There is no secondary top tab row, separate group-state store, or second Drawer.

## Header and account actions

The desktop header contains only brand chrome, the Main-site switch, theme control and the Account menu. Mobile additionally carries the required single Drawer trigger.

The Account menu owns:

- the account/admin surface switch when authorized;
- usage guidelines;
- privacy policy;
- logout and its in-progress disabled state.

An account without an active admin principal never receives the Management switch.

## Test coverage

The IA contract includes:

- full and reduced permission matrices;
- feature and policy gate combinations;
- direct nested-route current state;
- browser back restoration;
- mobile Drawer context, focus containment and 44px controls;
- account-menu policy/logout availability;
- desktop 768px sidebar overflow checks.
