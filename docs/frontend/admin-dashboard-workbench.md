# Admin dashboard task workbench

`/user/manage` is a task workbench, not an analytics landing page. Its content is a vertical operating flow: `今日待处理`, `最近变更`, then `系统状态`.

This document owns dashboard task and summary composition only. Admin module taxonomy belongs to [Admin information architecture](admin-information-architecture.md); frame, navigation, CSS and motion responsibilities belong to the focused account layout documents.

## First-fold contract

The workbench derives pending work in a stable order:

1. pending comment moderation;
2. pending message-center tickets;
3. cache and index incidents;

When those queues are clear, they collapse into one complete `暂无待处理` state with `写新文章` as the explicit next step. Empty task rows, reserved columns and viewport-filling minimum heights are forbidden.

Each visible row remains a link while its count is loading, unavailable, or high. Loading and failure copy says what is being checked and names the destination where the operator can continue. Its trailing action is a 40px desktop / 44px mobile target with an explicit `处理` or `检查` label; a weak floating `开始` label is not a valid primary action.

At a 1366 x 768 desktop viewport, the title and either the first actionable task or the complete healthy state must fit before the lower fold. Mobile preserves the same semantic order and only changes row composition.

## Recent changes

The dashboard reads at most five PII-redacted audit records when the principal has `audit.read`. It groups each record as article, comment, policy, or system change and links contextually to the audit log. Lack of audit permission is a supported empty state, not an authorization error. Loading and failure stay inside the region and do not block pending tasks.

## System status

System status is one aggregate row backed by the existing cache, index and distribution diagnostics. Healthy systems produce one quiet `系统处于预期状态` summary; incidents produce one directly actionable row. The compact site ledger remains below it as an aggregate definition list and does not become a KPI-card wall.

## Summary boundary

The site summary is a semantic `dl` ledger with compact tabular article, comment, and trash values. It has no read-total metric, decorative icons, elevated KPI cards, large display numerals, charts, or card shadows. Detailed reading, RUM, AOT, source, and regional analysis stays on `/user/manage/analytics`; the workbench links there instead of importing analytics panels.

The summary has explicit states:

- loading: announces that the summary is being read;
- error: explains the failure and offers `重新加载摘要`;
- zero: explains that content or interaction has not been produced and points to writing the first article;
- ready: renders all values, including zero, without truthy-value elision.

## Data and cache boundary

The workbench does not add or change backend APIs. It composes existing binary endpoints concurrently:

- stats overview for the compact ledger;
- comment moderation queue counters;
- pending admin conversations;
- cache diagnostics.
- five PII-redacted audit records when the principal has `audit.read`.

Cache incidents are counted per AOT, search, distribution, and output-cache subsystem. If all subsystem states are healthy but the aggregate state is degraded, the workbench preserves one aggregate incident instead of showing a false zero.

## Feedback migration

Repository feedback is available from a collapsed `帮助与反馈` disclosure in the page header. The closed first view contains no GitHub, Issue, or repository-maintenance prompt. External destinations use neutral operator labels and retain `noopener noreferrer` isolation.

## Acceptance coverage

The presentation component is independently mountable so its visual matrix does not depend on mutable backend workload. The no-backend visual suite covers:

- 1366x768, 1440x900, 768px and 375px viewports;
- zero, one and eight pending tasks;
- no and multiple recent changes;
- healthy and abnormal system states;
- Light and Dark themes;
- a grayscale pass;
- task CTA geometry, keyboard focus, readable sidebar helper text, compact ledger semantics, help disclosure interaction, console health and horizontal overflow.

The live admin-console acceptance suite separately verifies the real dashboard route and direct actions.
