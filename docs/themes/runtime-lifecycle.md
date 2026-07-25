# Theme activation runtime

## Current production state

The only theme capability wired in production is `themeRuntime.ts` — a
light/dark/system mode toggle with localStorage persistence, DOM attribute
synchronization (`data-theme-mode` / `data-theme-resolved`), MutationObserver
for external DOM changes, AOT hydration reconciliation, and a Vue composable
(`useThemeRuntime`). It is consumed by `ThemeModeToggle.vue`,
`bootstrap/publicShell.ts`, `App.vue`, and `public-renderers/`.

## Planned v1.3.0 capabilities

The theme activation service described below (`ThemeActivationRuntimeService`,
theme asset loading via `themeAssetRuntime`, CSS failure fallback, atomic
rollback, default reset, and the full preview → active → default lifecycle) is
planned for v1.3.0 (tracking issue #138). `themeAssetRuntime.ts` provides the
type contracts and browser load/failure infrastructure but is not yet wired
into any production entry or bootstrap path. Its only current consumer is the
unit test `tests/frontend/unit/services/themeAssetRuntime.test.ts`.

## Planned scope and activation flow

Preview accepts only `user-preview:{positiveUserId}`. It writes an independent
activation pointer for that user and never changes `site-wide`, `public`,
`admin` or `console`. Shared activation refuses a user-preview scope so callers
cannot accidentally turn a preview into a public mutation.

Every preview or apply performs this sequence:

```text
read installed registry row
-> reopen content-addressed archive
-> validate manifest and CSS safety
-> verify exact package and entry/asset hashes
-> read current config version
-> atomically write activation pointer + history/evidence
-> publish runtime event
-> shared scopes only: advance asset-cache version and evict Theme/AOT/SystemPage
```

The pointer persists `activation_id`, `active_theme_id`, `asset_version`
(the exact package SHA-256), `config_version`, `mode` and update time.
`theme_activation_history` stores the new and previous values, actor,
`applied|rejected|rolled_back|reset_to_default`, timestamps, bounded failure
reason and source-generated JSON evidence. A rejected rescan writes history
without changing the pointer.

## Planned atomic rollback and default reset

Rollback requires the activation UUID observed by the caller. The registry
locks the scope row and rejects a stale UUID before mutation. It then restores
the previous theme id, package hash, config version and mode from the original
history record in one transaction. If the activation had no previous theme,
rollback deletes the scope pointer and the built-in default remains active.

Default reset is the no-restart hot-disable path for a scope. It deletes that
scope pointer, recalculates enabled registry state, appends
`reset_to_default` evidence and invalidates shared theme consumers. It does
not delete installed packages or configuration, so an operator can later
reapply a validated version.

If event/cache publication fails after a database apply, the service performs
a fenced automatic rollback and throws `theme_activation_publish_failed`.
The database rollback is authoritative even if publishing the rollback event
also fails; no failure path reactivates the rejected version.

## Planned browser CSS failure

`themeAssetRuntime` loads each candidate with `media="not all"` and does not
change root attributes or remove the previous link until the candidate emits
`load`. A preview failure falls through to active, then default; an active
failure falls through to default. Its optional reporter receives:

```text
source, themeId, contentHash, activationId, code, detail
```

Reporter failure is best-effort and cannot block fallback. A server adapter
may submit the record to `ReportRuntimeCssLoadFailureAsync`; that method
accepts it only when scope, activation UUID, theme id and content hash still
match the current pointer. A late report returns
`theme_runtime_failure_stale` rather than rolling back a newer activation.

## Planned risk, rollback and compatibility

- A migration adds nullable version columns to existing activation rows and a
  new history table. Old rows remain readable but cannot be used as a fenced
  runtime CSS rollback target until a new activation publishes a UUID.
- Package, config and asset versions are references to existing immutable
  state. Rollback never reconstructs missing files or accepts a hash mismatch.
- The no-restart safety actions are fenced rollback or default reset. Do not
  loosen CSS ceilings, hand-edit evidence, reuse a stale UUID or delete the
  previous content-addressed package.
- Anonymous, logged-in, admin, notification stream and binary request
  contracts are unchanged. Theme failures affect only stylesheet selection
  and derived public shell cache entries.
