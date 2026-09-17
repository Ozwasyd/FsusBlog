# Frontend account and admin route boundaries

`/user/*` contains two independent authenticated surfaces. The router preserves the backend principal split; it does not treat either Session as generic identity. URL handling is defined by [frontend navigation privacy](frontend-navigation-privacy.md).

## Route metadata

- `requiresAccountSession: true` marks self-service routes (`/user/identity`, `/user/comments`, `/user/messagebox`); only a confirmed account Session may enter.
- `requiresAdminSession: true` marks `/user/manage/*`; only a confirmed administrator Session may enter.
- `requiredAdminPermissions: string[]` is mandatory on every manage route and is evaluated only after an active administrator Session is confirmed.
- `requiresConfirmedIdentity: true` is reserved for `/user`, probes both Session domains before choosing a landing route, and is not an authorization union.
- `requiresAuth` remains for non-account legacy records; no `/user/*` application route may depend on it.

An administrator Session never satisfies `requiresAccountSession`; an account Session never satisfies `requiresAdminSession` or any administrator permission.

## Decisions

| Confirmed state | `/user` | self route | manage route |
| --- | --- | --- | --- |
| no Session | login | login | login |
| account only | `/user/identity` | allow | 403 |
| administrator only | `/user/manage` | login | allow if permitted |
| both Sessions | `/user/manage` | allow | allow if permitted |
| account expired | login unless administrator is active | login | administrator decision |
| administrator expired | account landing when account is active | account decision | 403 when account is active, otherwise login |
| administrator permission missing | manage landing then 403 | account decision | 403 |

The `/user` root confirms both domains before redirecting: active administrator → manage surface; otherwise active account → identity surface; otherwise login receives the sanitized `/user` return target.

## Navigation privacy and commit order

Before authorization redirects, query fields are reduced to the route allowlist. Fragments and undeclared `token`/`details`/record identifiers never enter a login `redirect`; a 403 navigation copies neither query nor fragment.

Authorization completes in `beforeEach`. A rejected self/manage target never reaches `beforeResolve`, becomes current, or resolves its lazy view. Pinia identity conclusions remain separate facts; the router never promotes one Session into the other store.

## Risk and rollback

The main compatibility risk is missing identity metadata making a route public. The route-catalog unit test enumerates every `/user` deep link and requires exactly one identity requirement, except the confirmed-identity root.

For a navigation regression, shift the active static frontend artifact to the previous verified artifact or disable SPA takeover at the serving layer; no backend restart is needed. Backend account/administrator Principal checks remain authoritative, so rollback cannot grant backend access.
