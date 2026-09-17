# CSP style attribute hardening

## Security invariant

Production and development responses set `style-src-attr 'none'`. Application source must not render `style="..."`, Vue `:style`, render-function `style` props, or mutate `HTMLElement.style`. Static presentation belongs in compiled stylesheets. Values that must vary at runtime use `cspStyleRuntime`: it creates an internal class, writes declarations through `CSSStyleDeclaration.setProperty`, and attaches the rule to a request-nonce-authorized `<style>` element. Property names are validated and the binding removes its class and stylesheet on disposal.

The permission to compile WebAssembly is scoped to HTML documents because the trusted AEDS decoder is loaded from those documents. Static assets, AEDS/binary responses, auth responses, admin API responses, notification stream handshakes, errors, and CSP report responses use the non-HTML policy and do not contain `'wasm-unsafe-eval'`.

## Violation collection and privacy

Every policy includes `report-uri /api/security/csp-report`. The anonymous collector accepts legacy `application/csp-report`, Reporting API `application/reports+json`, and JSON compatibility bodies. It is protected by the fixed-IP limiter and a 16 KiB body cap, returns `204` for a valid report, and is always `no-store`.

Logs contain only normalized `effective-directive`, `disposition`, and a blocked-resource category such as `inline`, `https`, or `relative-uri`. Full document URLs, blocked URLs, query strings, fragments, cookies, authorization values, DOM samples, source snippets, account identity, and report bodies are never logged. Invalid media types, oversize payloads, and malformed JSON fail closed without echoing input.

## Compatibility and rollback

The browser matrix must load public, login/account, admin, notification-stream, and binary flows without an unexpected `securitypolicyviolation`. A deliberate untrusted script and a deliberate style attribute must still be blocked. Chrome, Firefox, Safari, and Edge evidence is required for release closeout; focused unit and static checks are the local precondition, not a substitute.

If a CSP-safe class migration causes a production regression, keep CSP enforcement enabled. First hot-disable `PublicHotRead:Enabled` when the symptom is isolated to the public L0 document path, then use the existing Blue/Green deployment control to reactivate the preceding verified release slot. Both actions avoid restarting the serving process; neither reintroduces `style-src-attr 'unsafe-inline'`, broadens `script-src`, disables PoW/risk controls, or changes AEDS wire semantics. After rollback, use the collected directive/category aggregate to identify the missing class migration before retrying the candidate.
