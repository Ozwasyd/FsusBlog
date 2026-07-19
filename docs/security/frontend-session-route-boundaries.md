# Frontend account and admin route boundaries

`/user/*` contains two independent authenticated surfaces. The frontend router must preserve the same principal split as the backend instead of treating either Session as a generic authenticated identity.

## Route metadata

- `requiresAccountSession: true` marks self-service routes such as `/user/identity`, `/user/comments`, and `/user/messagebox`. Only a confirmed account Session can enter these routes.
- `requiresAdminSession: true` marks `/user/manage/*`. Only a confirmed administrator Session can enter these routes.
- `requiredAdminPermissions: string[]` is mandatory on every manage route and is evaluated only after an active administrator Session is confirmed.
- `requiresConfirmedIdentity: true` is reserved for `/user`. It probes both Session domains before choosing a landing route and is not an authorization union.
- `requiresAuth` remains supported for non-account legacy route records, but no `/user/*` application route may depend on it.

An administrator Session never satisfies `requiresAccountSession`. An account Session never satisfies `requiresAdminSession` or any administrator permission.

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

The `/user` root confirms both identity domains before redirecting. An active administrator Session is routed to the manage surface; otherwise an active account Session is routed to the identity surface; otherwise login receives the sanitized `/user` return target.

## Navigation privacy and commit order

Private query fields are reduced to the route allowlist before authorization redirects. Fragments and undeclared fields such as `token`, `details`, or record identifiers never enter a login `redirect` value. A 403 navigation has no copied query or fragment.

Authorization is completed in `beforeEach`. A rejected self or manage target therefore does not reach `beforeResolve`, does not become the current route, and does not resolve its lazy view component. Existing Pinia identity conclusions are read as separate facts; the router does not promote one Session into the other store.

## Risk and rollback

The main compatibility risk is a route with missing identity metadata becoming public. The route catalog unit test enumerates every `/user` deep link and fails unless it declares exactly one identity requirement (except the confirmed-identity root).

If a newly deployed frontend produces a navigation regression, shift the active static frontend artifact to the previous verified artifact or disable SPA takeover at the serving layer. This rollback does not require restarting the backend. Backend account and administrator Principal checks remain authoritative throughout, so rollback cannot make a frontend route grant backend access.
