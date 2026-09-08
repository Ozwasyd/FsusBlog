# Theme activation runtime

## Current production state

The only production theme capability is `themeRuntime.ts`: a light/dark/system toggle with localStorage persistence, `data-theme-mode` / `data-theme-resolved` synchronization, MutationObserver handling for external DOM changes, AOT hydration reconciliation, and `useThemeRuntime`. Consumers are `ThemeModeToggle.vue`, `bootstrap/publicShell.ts`, `App.vue`, and `public-renderers/`.

## Planned v1.3.0 capabilities

The activation service below (`ThemeActivationRuntimeService`, `themeAssetRuntime`, CSS-failure fallback, atomic rollback, default reset, and preview → active → default lifecycle) is planned for v1.3.0 (issue #138). `themeAssetRuntime.ts` currently supplies only type contracts and browser load/failure infrastructure; it is not wired into production entry/bootstrap and is consumed only by `tests/frontend/unit/services/themeAssetRuntime.test.ts`.

## Planned scope and activation flow

Preview accepts only `user-preview:{positiveUserId}` and writes that user's independent pointer; it never changes `site-wide`, `public`, `admin`, or `console`. Shared activation rejects a user-preview scope, preventing a preview from becoming a public mutation.

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

The pointer persists `activation_id`, `active_theme_id`, `asset_version` (exact package SHA-256), `config_version`, `mode`, and update time. `theme_activation_history` stores new/previous values, actor, `applied|rejected|rolled_back|reset_to_default`, timestamps, bounded failure reason, and source-generated JSON evidence. A rejected rescan writes history without changing the pointer.

## Planned atomic rollback and default reset

Rollback requires the caller-observed activation UUID. The registry locks the scope row, rejects a stale UUID, and restores the previous theme ID, package hash, config version, and mode from the original history record in one transaction. With no previous theme, it deletes the scope pointer and leaves the built-in default active.

Default reset is the no-restart hot-disable path: delete the scope pointer, recalculate enabled registry state, append `reset_to_default` evidence, and invalidate shared theme consumers. It never deletes installed packages or configuration, so a validated version can be reapplied.

If event/cache publication fails after database apply, the service performs a fenced automatic rollback and throws `theme_activation_publish_failed`. The database rollback is authoritative even if its rollback event also fails; no failure path reactivates the rejected version.

## Planned browser CSS failure

`themeAssetRuntime` loads each candidate with `media="not all"`, changes no root attributes, and removes no previous link until candidate `load`. Preview failure falls through to active then default; active failure falls through to default. The optional reporter receives:

```text
source, themeId, contentHash, activationId, code, detail
```

Reporter failure is best-effort and cannot block fallback. A server adapter may call `ReportRuntimeCssLoadFailureAsync`, which accepts a record only when scope, activation UUID, theme ID, and content hash still match the current pointer. A late report returns `theme_runtime_failure_stale` and never rolls back a newer activation.

## Planned risk, rollback and compatibility

- A migration adds nullable version columns and a history table. Old rows remain readable but cannot be fenced runtime-CSS rollback targets until a new activation publishes a UUID.
- Package/config/asset versions reference immutable state; rollback never reconstructs missing files or accepts a hash mismatch.
- No-restart safety actions are fenced rollback or default reset. Do not loosen CSS ceilings, hand-edit evidence, reuse a stale UUID, or delete the previous content-addressed package.
- Anonymous, logged-in, admin, notification-stream, and binary contracts are unchanged; failures affect only stylesheet selection and derived public-shell cache entries.
