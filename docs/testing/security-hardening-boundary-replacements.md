# Issue #1037: security-hardening boundary-test replacements

Issue #1037 removes five xUnit files that guessed security behavior with `File.ReadAllText` and string fragments, replacing them with real service/endpoint boundaries and a Roslyn AST policy. All 19 old test IDs remain in `tests/backend/issue-1037-retention-replacements.json` and must not disappear in the central retention merge. The [security source policy](security-hardening-source-policy.md) is the canonical static owner.

## Dependency status

The issue body declares a dependency on #1032. A read-only GitHub check on 2026-07-11 found #1032 open with no comments, while #1037's typed dependency API returned an empty set: this is a body dependency, not a typed GitHub dependency. Local `master` contains the #1032 implementation commit; coverage, matrix, backend-requirement, static-governance, and central-retention wiring exist but still require unified validation and GitHub synchronization.

## Observable boundaries

| Risk domain | Authoritative evidence |
| --- | --- |
| Path injection | `CanonicalPathBoundary` fails closed for URL encoding, backslashes, absolute paths, lexical escape, and physical symlink escape; AOT sidecar, SSR worker, and admin-upload paths share it, and a local fixture runs the real validator. |
| Input DoS | Overlong search terms return before database scope creation; filtering rejects before large allocation; real entry points execute authoring DataAnnotations, public navigation, subscription, local storage/redirect, and passkey JSON depth/length checks. |
| Cryptography | Security snapshot IDs use injectable `ISecurityRandomSource` CSPRNG; sensitive hex/UTF-8 comparisons use a fixed-time helper; the AST policy owns minimum Argon2/PBKDF2 parameters. |
| Information disclosure | Real output checks cover production exception AEDS responses, startup reports, local-fixture status, and structured-log fields; the AST policy blocks sensitive log templates and raw exception output outside logs. |
| Upload | `TestServer` runs the upload-part handler for content type, chunked/missing length, and declared over-limit cases; `FileService` covers AVIF, traversal, and cancellation without progress/temp artifacts. |

The public upload-part schema is unchanged. The handler maps the existing request-body limit explicitly to `413` before storage; Kestrel's global limit remains the outer guard.

## Risk and rollback

- A path-parser failure rejects access; it never falls back to string-prefix checking.
- Roslyn checks only scopes listed in `security/policies/backend-source-policy.json`; every new rule needs positive and negative fixtures, avoiding repository-wide regex false positives.
- If a new boundary breaks compatibility, roll back call sites by domain, never the removed source-string tests. Upload may retain Kestrel's outer limit and restore the handler's explicit `413` without restarting other services.

## Verification status

Per the current parallel-implementation instruction, this issue has not run tests, build, restore, lint, syntax checks, or the analyzer. These files are implementation-only evidence until central wiring is validated and results are filled in from the actual run.
