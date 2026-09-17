# Issue #1247 Private Navigation Matrix

The acceptance lane is local-only and uses Vue Router Memory History. It does not call production or any external service.

| Scenario | Input | Expected browser-visible state |
| --- | --- | --- |
| Anonymous account route | `/user/messagebox?filter=unread&conversation=account-42#account-42` | `/login?redirect=/user/messagebox?filter=unread` |
| Anonymous dynamic admin object | `/user/manage/article/edit/987654?proof=secret#draft` | `/login?redirect=/user/manage`; no object id or proof |
| Logged-in account | allowlisted message filter plus token/details/fragment | only the validated filter remains |
| Admin search | page/status plus account or article keyword | page/status remain; free text is memory-only |
| MFA/recovery/step-up/proof | sensitive route or credential-like query | account/admin landing fallback; payload never copied |
| Malicious redirect | absolute URL, protocol-relative URL, backslash, or control character | configured local fallback |
| Back/forward | navigate away from a sanitized private URL and return | only sanitized history entries are observed |
| Refresh | object selection existed only in memory | safe unselected/default view; no sensitive echo |
| Notification stream | inbox patch selects/updates an object | selection remains component memory; envelope is not serialized into URL |
| Binary | AEDS response or failure | no routing-policy code receives payload/details; existing binary telemetry privacy gate remains authoritative |

## Commands

Run from `src/frontend`:

```bash
pnpm exec vitest run --config vitest.config.ts ../../tests/frontend/unit/security/privateNavigationPolicy.test.ts ../../tests/frontend/unit/router/index.test.ts
pnpm run check:private-navigation-policy
pnpm run check:private-runtime-governance
```

The first command covers complete private URLs, malicious redirects, route classification, refresh degradation, and back/forward behavior. The dedicated static gate rejects reintroduction of conversation ids or admin keywords into route queries and requires the four route metadata classes. The existing private-runtime gate supplies non-regression coverage for notification-stream lifecycle and binary telemetry boundaries.
