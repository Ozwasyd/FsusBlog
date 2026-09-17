# Frontend Navigation Privacy

Issue #1247 defines state allowed in browser-visible URLs/history. The policy runs before private-route commit and login-return construction; principal separation is covered by [frontend account/admin route boundaries](frontend-session-route-boundaries.md), and memory cleanup by [private-surface runtime](private-surface-runtime.md).

## Route state classes

Every named route declares one of four `routeState` values.

| Class | URL contract | Login recovery |
| --- | --- | --- |
| `public-shareable` | Public path, query, and fragment may be shared | Not a private login target |
| `private-recoverable` | Only route-declared, validated low-cardinality query fields; no fragment | Allowed only when `allowLoginRedirect: true` and the route has a name |
| `session-sensitive` | Route may host MFA, recovery, challenge, step-up, or proof state; payload stays in memory | Falls back to the account or admin landing page |
| `memory-only` | Private object selection and drafts stay in component memory | Falls back to the account or admin landing page |

`routeState` and `allowLoginRedirect` are static metadata. A private route is not recoverable merely because its path begins with `/user`: its name, state class, and recovery flag must opt in, and dynamic params are never copied into a login redirect.

## Private query declaration

`privateNavigationPolicy.ts` is authoritative: undeclared fields and every private fragment are discarded; declared values are validated, not merely truncated.

| Route | Recoverable fields | Value boundary | Memory-only examples |
| --- | --- | --- | --- |
| `UserMessage` | `filter` | `all`, `unread`, `closed` | conversation id, reply draft |
| `ManageUsers` | `page`, `pageSize`, `status` | bounded positive page; declared size/status enums | account keyword, selected account, ban reason |
| `ManageArticleList` | `page`, `size`, `categoryId`, `tagId`, `status` | positive identifiers and declared enums | title keyword, selected article |
| `ManageWriteArticle`, `ManageEditArticle` | `preview` | `private` only | draft content, proof, editor object selection |
| `ManageModerationRegions` | `region` | bounded low-cardinality token | policy payload |
| `ManageAuditLog` | `action`, `outcome`, `severity`, `source`, `type`, `targetType` | bounded low-cardinality tokens | actor, target id, date range, investigation details |

Credential-like names (`token`, `proof`, `challenge`, `mfa`, `recovery`) are never declared. Account/article searches and conversation selection stay in memory, so refresh returns to an unselected/default view.

## Redirect and history behavior

External, protocol-relative, backslash, control-character, unnamed, dynamic-object, `session-sensitive`, and `memory-only` redirect targets fail closed. Safe private targets are rebuilt from the route name and validated query policy; incoming `fullPath`, params, and fragments are never copied.

Guards replace a dirty URL before browser history; back/forward sees only the sanitized entry. Refresh with unrecoverable object state loads the safe default without echoing the discarded identifier.

## Risk and no-restart rollback

Removing `allowLoginRedirect` or changing a route to `session-sensitive`/`memory-only` sends its next login recovery to `/user/identity` or `/user/manage`; removing a query field strips it on the next navigation. These frontend asset changes need no backend restart, and the older rollout bundle remains bounded by server authorization.

Conservative failure loses convenience state, never authentication/authorization state. Notification envelopes and AEDS binary payloads remain outside URL construction and unchanged.
