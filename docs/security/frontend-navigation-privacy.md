# Frontend Navigation Privacy

Issue #1247 defines which state may appear in browser-visible URLs and history. The policy applies before a private route is committed and before a login return target is produced.

## Route state classes

Every named route declares one of four `routeState` values.

| Class | URL contract | Login recovery |
| --- | --- | --- |
| `public-shareable` | Public path, query, and fragment may be shared | Not a private login target |
| `private-recoverable` | Only route-declared, validated low-cardinality query fields; no fragment | Allowed only when `allowLoginRedirect: true` and the route has a name |
| `session-sensitive` | Route may host MFA, recovery, challenge, step-up, or proof state; payload stays in memory | Falls back to the account or admin landing page |
| `memory-only` | Private object selection and drafts stay in component memory | Falls back to the account or admin landing page |

`routeState` and `allowLoginRedirect` are static route metadata. A new private route is not recoverable merely because its path begins with `/user`: the route name, state class, and recovery flag must all opt in. Dynamic params are not copied into a login redirect.

## Private query declaration

`privateNavigationPolicy.ts` is the authoritative field policy. Undeclared fields and every private fragment are discarded. Declared values are validated, not merely truncated.

| Route | Recoverable fields | Value boundary | Memory-only examples |
| --- | --- | --- | --- |
| `UserMessage` | `filter` | `all`, `unread`, `closed` | conversation id, reply draft |
| `ManageUsers` | `page`, `pageSize`, `status` | bounded positive page; declared size/status enums | account keyword, selected account, ban reason |
| `ManageArticleList` | `page`, `size`, `categoryId`, `tagId`, `status` | positive identifiers and declared enums | title keyword, selected article |
| `ManageWriteArticle`, `ManageEditArticle` | `preview` | `private` only | draft content, proof, editor object selection |
| `ManageModerationRegions` | `region` | bounded low-cardinality token | policy payload |
| `ManageAuditLog` | `action`, `outcome`, `severity`, `source`, `type`, `targetType` | bounded low-cardinality tokens | actor, target id, date range, investigation details |

Credential-like names such as `token`, `proof`, `challenge`, `mfa`, and `recovery` are never declared. Account and article search text and conversation selection remain in memory, so refresh safely returns to an unselected/default view.

## Redirect and history behavior

External, protocol-relative, backslash, control-character, unnamed, dynamic-object, session-sensitive, and memory-only redirect targets fail closed. Safe private targets are reconstructed from the route name and validated query policy; the incoming `fullPath`, params, and fragment are never copied.

Private route guards replace a dirty URL before it reaches browser history. Back/forward therefore sees only the sanitized entry. A refresh with unrecoverable object state loads the safe route default without echoing the discarded identifier.

## Risk and no-restart rollback

Removing `allowLoginRedirect` or changing a route to `session-sensitive`/`memory-only` immediately degrades its next login recovery to `/user/identity` or `/user/manage`. Removing a field from the query policy immediately strips it on the next navigation. These are frontend asset changes and require no backend restart; during rollout, the older bundle remains bounded by the server's existing authorization checks.

The conservative failure mode loses convenience state, never authentication or authorization state. Notification stream envelopes and AEDS binary payloads remain outside URL construction and are unchanged by this policy.
