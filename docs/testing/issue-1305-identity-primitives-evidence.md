# Issue 1305 identity primitive evidence

## Source baseline

The pre-migration source was `master@7259a829` with the upstream typography
dependency supplied by FsusUI `main@9c2a6a9f` (including #219 at
`91741626ba`). `ProfileSettingsPrimitives.ts` locally recreated section,
resource-row, metadata, action and empty-state markup. Its readable supporting
copy used 13px, resource metadata used 11px, and row/action stacking was owned
by Blog utility classes.

## After migration

The identity and profile surfaces now consume the following public FsusUI
primitives through `src/frontend/src/fsusui/`:

| Surface | Canonical primitive | Visible difference classification |
| --- | --- | --- |
| Passkey credentials | `ResourceList`, `ResourceListItem`, `MetadataRow`, `MetadataItem`, `InlineActions` | Canonical primitive adoption: border, radius, padding, 12px metadata, row rhythm and mobile action stacking. |
| Active sessions | `ResourceList`, `ResourceListItem`, `MetadataRow`, `MetadataItem`, `InlineActions` | Canonical primitive adoption: one resource grammar and labelled metadata. |
| Empty passkeys/sessions/profile redirect | `EmptyState size="inline"`, `illustration="false"` | Canonical primitive adoption: flat, quiet, illustration-free settings state. |
| Recovery key and MFA | Existing Blog composition inside `SettingsSection` | Directly required product composition: secret, checkbox and verification policy remain Blog-owned. |
| Account deletion | `DangerZone`, `RiskNotice`, `DestructiveActionPanel`, `InlineActions` | Canonical primitive adoption around unchanged Blog confirmation and deletion policy. Consequences remain explicit in text and do not rely on color. |

The source order remains heading, description, metadata/content, then actions.
FsusUI owns desktop/mobile and light/dark presentation; no consumer `:deep()`
override or internal BEM selector was added. The 44px product touch target on
credential/session destructive buttons remains a direct accessibility
composition requirement.

## Visual matrix and regression boundary

FsusUI #219 supplies the canonical `SectionNav`, `SettingsSection`,
`SectionHeader` and `ResourceList` before/after matrix for desktop/mobile and
light/dark. The downstream expected differences are limited to those listed
above. Identity information architecture, route order, copy meaning, API calls,
passkey/session/recovery/MFA workflows and delete confirmation are unchanged.

A full downstream browser screenshot matrix requires the repository debug
stack and authenticated binary fixtures. If that environment is unavailable,
the focused source, type and template checks are the acceptance evidence; this
document must not be read as a claim that the full browser matrix ran locally.

One focused downstream browser check ran against the local FsusUI workspace
source with the local fixture-session route and mocked unavailable APIs:

| Case | Result |
| --- | --- |
| Desktop 1366x900, light | One each of `DangerZone`, `RiskNotice` and `DestructiveActionPanel`; one h2 and one delete button; explicit consequence text present; 0px horizontal overflow; zone 943x241px. |
| Mobile 390x844, dark | The same semantic counts and consequence text; dark theme resolved; 0px horizontal overflow; zone 358x334px with canonical mobile stacking. |

The API mock deliberately returned 503 outside the local fixture-status route,
so this directed check proves component loading, semantic hierarchy, theme,
stacking and overflow only. It is not evidence for passkey/session data flows or
the complete desktop/mobile by light/dark screenshot matrix.
