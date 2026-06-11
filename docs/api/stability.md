# API Stability

FsusBlog v1.1.x is a public preview. Its internal application APIs are available for development and evaluation, but they are not stable compatibility contracts for third-party clients.

## v1.1.x Compatibility Rules

During v1.1.x:

- Internal AEDS frame contracts are experimental.
- Undocumented internal APIs may change without compatibility guarantees.
- Database schema may change.
- Admin API routes may change.
- Deployment configuration may change.
- No compatibility guarantee is provided for third-party clients.
- Performance profiles must identify whether they use the Kestrel-only baseline or optional deployment layers such as reverse proxy or CDN.

These rules apply even when the current implementation is documented for maintainers. A route or frame becomes a stable public extension point only when a stability document explicitly says so.

## v1.2.0 And Later

From v1.2.0 onward:

- Stable public extension points will be documented explicitly.
- Undocumented internal APIs remain unstable.
- Breaking-change policy will be tied to the specific stable extension point, not to every internal endpoint.

## Standard Protocols

The following outputs are standard external protocols or operational probes, not internal AEDS APIs:

- RSS
- Atom
- JSON Feed
- Sitemap
- `robots.txt`
- health probes

They should stay standards-compatible and should not be interpreted as evidence that undocumented binary/admin/internal routes are stable.

## Internal Binary API

The `/api/binary/**` runtime surface is the main application transport. It is optimized for FsusBlog clients and shared contracts inside this repository. Do not build third-party clients against undocumented AEDS frames unless you accept breakage during public preview.

## Admin And Deployment APIs

Admin routes, operations probes, release evidence formats, and deployment configuration may change during public preview. Treat these as maintainer-facing implementation contracts unless a future stable extension document says otherwise.
