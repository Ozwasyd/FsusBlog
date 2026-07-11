# Admin dashboard task workbench

`/user/manage` is a task workbench, not an analytics landing page. Its first content region is always `今日待处理`, followed by one compact site-summary ledger.

## First-fold contract

The workbench exposes four direct actions in a stable order:

1. pending comment moderation;
2. pending message-center tickets;
3. cache and index incidents;
4. writing a new article.

Each row remains a link while its count is loading, unavailable, zero, or high. Loading and failure copy says what is being checked and names the destination where the operator can continue. Zero states explain why there is no work and what the next useful action is; they never fall back to a generic large `暂无数据` card.

At a 1366 x 768 desktop viewport, the title, all four task rows, and the complete site-summary ledger must fit before the lower fold. Mobile uses the same order and changes only the ledger from one row to two rows.

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

Cache incidents are counted per AOT, search, distribution, and output-cache subsystem. If all subsystem states are healthy but the aggregate state is degraded, the workbench preserves one aggregate incident instead of showing a false zero.

## Feedback migration

Repository feedback is available from a collapsed `帮助与反馈` disclosure in the page header. The closed first view contains no GitHub, Issue, or repository-maintenance prompt. External destinations use neutral operator labels and retain `noopener noreferrer` isolation.

## Acceptance coverage

The presentation component is independently mountable so its visual matrix does not depend on mutable backend workload. The visual suite covers:

- desktop and mobile;
- zero and high workload;
- Light and Dark themes;
- direct task links, compact ledger semantics, help disclosure interaction, and horizontal overflow.

The live admin-console acceptance suite separately verifies the real dashboard route and its four direct task actions.
