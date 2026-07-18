# A3-4 Legacy plain-cookie read retirement

Status: code landed; local-environment survey deferred.

## Change

`AuthCookieService` has no `AllowLegacyPlainCookieRead` field, decision method, or
`allowPlainFallback` parameter. Production reads only current `__Host-*` cookies.
Development may use the current non-host-prefixed cookie names only when
`AuthCookies:AllowInsecureTransportCookies` is explicitly enabled; that is transport
configuration, not a legacy-name fallback. The removed key is absent from startup
validation and application settings, and setting it no longer changes behavior.

## Release gate

Record a local configuration/browser-session survey showing that no supported
development workflow depends on the removed fallback. Reauthentication with current
cookie names is expected. This implementation phase authored the behavior evidence
but did not run it or survey developer machines.

## Operational fallback

Do not restore legacy cookie reads. Clear stale browser cookies and sign in again.
For local HTTP-only development, use the documented
`AllowInsecureTransportCookies` switch; production remains Secure, HttpOnly,
SameSite=Strict, host-prefixed, and path `/`.

## Test ownership

- `AuthCookieServiceSecurityTests.ReadTokenCookies_DevelopmentRejectsLegacyPlainCookieFallback`
- `ProductionStartupValidatorTests.ValidateCore_IgnoresRemovedLegacyPlainCookieReadSwitch`
- `RuntimeFallbackRetirementAcceptanceTests.A3_4_LegacyPlainCookieSwitchCannotRestoreFallback`
