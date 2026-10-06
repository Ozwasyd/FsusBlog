# Article PropertyDefinition authority

`ArticlePropertyDefinitionStore` is the single server-side authority for user/site-scoped article property definitions. It owns definition facts and schema history; it does not own article property values, search queries/indexes, inspector UI, system metadata, or legacy value migration.

## Closed schema

The versioned registry accepts exactly these eight value types:

| Type | Definition-only policy |
| --- | --- |
| `text` | Unicode-normalized text with bounded length constraints |
| `number` | Invariant decimal canonicalization with bounded numeric range |
| `boolean` | Canonical `true`/`false` scalar |
| `date` | UTC round-trip timestamp |
| `single-select` | One stable option ID |
| `multi-select` | Ordered stable option IDs with bounded cardinality |
| `article-reference` | Stable article IDs with declared cardinality and reference policy |
| `url` | Canonical URL with bounded schemes, length, and relative/absolute policy |

Unknown types, operators, constraints, executable expressions, raw JSON, HTML, scripts, and formulas fail closed. Options have stable IDs independent of labels; labels can be renamed without changing the option identity. Deleted options cannot be used by a new default. Article-reference policy explicitly records permission, cross-site, archived/deleted, self-reference, and cycle behavior. URL normalization never fetches or executes the URL.

Missing, null, empty, required, and default behavior is represented by `ArticlePropertyPresencePolicy` and `ArticlePropertyDefaultValue`. Defaults are type-checked and normalized before persistence. Definition content digests include the complete schema facts, policies, options, display names, flags, lifecycle status, and revision.

The scalar number normalizer retains the invariant `NumberStyles.Number` input
grammar and emits fixed decimal notation with up to 28 fractional digits. Its own
output is accepted again without exponent syntax or floating-point conversion.
Valid `defaultKind=None` is normalized to an absent default only after the complete
union payload is validated; raw accepted command history still records `None`.
PostgreSQL write parameters and hydration therefore preserve the same definition
and default digests. The candidate authority and runtime DDL reserve 37,000
characters for the complete 1,000-option GUID default (36,999 characters), without
reducing the option or schema budgets.

Date canonicalization keeps the invariant parser's calendar and offset semantics,
but requires an explicitly supplied calendar year. The year gate recognizes
bounded numeric calendar tokens and invariant English month tokens; it cannot
start inside a clock, fractional seconds or a numeric offset. Complete calendar
dates, full English dates, two-digit years in complete dates and stable year-month
forms remain accepted by the original parser. Time-only and month/day inputs that
borrow the current date or year fail closed. A timestamp without an offset is
interpreted as UTC; an explicit offset retains its actual instant. Every accepted
default emits a UTC round-trip timestamp, so replay never depends on the host time
zone or current date. This repairs replay interpretation, not only presentation.
Raw accepted command payloads remain unchanged. Older prototype history whose
unqualified scalar was interpreted using a local time zone must not be rewritten
or re-signed to claim that it originally used UTC; preserve it and keep any replay
mismatch invalid. No published 145/146 descriptor or checksum algorithm changes.

Management permission is checked before entering persistence for change-settings,
rename, deprecate and delete, including exact idempotent replay. A site administrator
whose `system.config` permission has been revoked cannot retrieve a successful old
management receipt using only `article.write`; existing read permission and
user-owner permission rules remain unchanged.

## Mutation and evidence boundary

Numeric constraints use typed PostgreSQL `numeric` without a fixed precision or
scale, preserving the complete accepted .NET decimal domain without rounding or
conversion through floating point. UTC date constraints use nullable signed
64-bit `min_date_utc_ticks` and `max_date_utc_ticks` columns, bounded to the .NET
DateTime tick range; hydration restores the exact 100 ns ticks and UTC kind.
These storage facts do not narrow the public decimal/UTC DateTime contract.
Verification admission also counts both numeric constraints' expanded decimal
byte lengths in SQL before decoding, including externally corrupted large values.
Mutation receipt timestamps retain their existing microsecond-aligned clock.
Previously rounded prototype constraints cannot be recovered from their stored
values or re-signed as the original input. The descriptor creates the new typed
schema; it does not silently alter or accept an earlier prototype layout. Reusing
such a database requires isolated writers and an explicitly authorized migration
or recreation of task-owned fixtures, preserving original evidence.

Create, change-settings, rename, deprecate, and delete all require owner and schema/owner revision CAS. A machine key is never changed by rename. Type changes are rejected in place and require a new definition/reconciliation plan. Delete requires a known affected-value count and never deletes values; unavailable value impact is a fail-closed reconciliation obligation. Every successful mutation writes one receipt, obligation set, signed audit link, and actor/request idempotency binding in the same transaction. Concurrent requests with a stale revision or a conflicting idempotency digest fail rather than last-write-wins.

Definitions are listed by keyset pagination with a maximum page size of 100 and a maximum of 1,000 live definitions per owner. Options and reference defaults are separately bounded at 1,000 entries. `ArticlePropertyDefinitionVerifier` revalidates the closed schema, contiguous revisions, receipt digests, idempotency bindings, obligations, and tamper-evident audit links.

## Forward command replay

History version 1 records the actual accepted create, change-settings, rename,
deprecate and delete commands as a closed, bounded internal binary envelope. It
retains original payloads, actor permission facts, identities and both expected
CAS revisions; it does not reconstruct commands from current facts or digests.
The 1 MiB command-envelope budget is separate from the unchanged 512 KiB
definition schema budget. Actor permissions and captured collections are immutable.

The existing definition owner transaction appends one owner-sequenced journal entry
binding its predecessor, command bytes, complete receipt and actual impact facts.
The existing signed Audit writer authenticates its domain-separated journal digest
in `EventInfo`; public receipt/journal hashes are not MACs. An empty genesis can
be established only while the locked owner has revision zero and no definitions
(including tombstones), receipts or commands. Nonempty legacy owners without the
original history fail closed for new mutations and verification. No legacy
backfill, reconstructed command, fabricated checkpoint or re-signing is performed.

Independent verification replays all owner commands from that authenticated empty
start, checks permissions/CAS/identity, normalized schemas and option/lifecycle
transitions, then compares every current fact including tombstones. It checks the
actual Audit HMAC and all actual preceding rows in each involved daily chain,
not a caller-supplied trust flag or adjacent text. Mutation and idempotent return
authenticate their particular journal/audit record and actual preceding row;
they do not claim that this bounded point check replaces full independent replay.
Impact facts are authenticated outputs of the existing impact-authority port, not
independent evidence about article values owned by #2323.

Complete verification has a 10,000-record limit and an independent 32 MiB aggregate
resource admission. PostgreSQL checks counts and uncompressed byte lengths before
hydrating owner facts, history payloads and audit rows. Verification owns a fresh
Repeatable Read transaction, sets isolation before its first SELECT (including
the owner advisory lock), and rejects ambient transactions. Admission and all
hydration see the same snapshot as of that first statement, not necessarily the
latest state after waiting for the owner lock. A later commit is assessed by a
later verification; this is neither a tamper-writer lock nor WORM. Normal mutation
transactions and their owner CAS are unchanged. Fixed object costs and
copy/UTF-16 multipliers bound the admitted working set estimate. This is not a
managed-heap quota or an execution measurement. Full history above either limit
returns Invalid/incomplete, never a truncated PASS. These verification budgets do
not change the 1,000-live-definition write limit or legal per-definition schema
sizes. One thousand small definitions remain eligible for complete replay; large
legal collections may need a future separately governed streaming verifier.

The additive `20261002-post-article-property-definition-command-history` descriptor
creates only journal/head tables with explicit online Expand metadata. It does not
rewrite the original 20260915 descriptor or create a second definition/value/query
store. DDL-compatible rollback keeps the new tables and history. Before running an
older writer, isolate definition writes: an old writer cannot maintain the new
journal, and a resulting gap must remain RED. Preserve audit keys, receipts and
history; never remove or rewrite them to manufacture compatibility.

Audit HMAC proves authorship by a holder of `Audit:TamperEvidenceKey`, not WORM or
protection against that holder rewriting the whole database. This replay verifier
does not verify detached checkpoints or an external expected head; those stronger
claims remain with the existing [detached checkpoint authority](../security/audit-detached-checkpoints.md).
Previously persisted weak digests/receipts require an explicitly authorized
recovery plan and original evidence; this change neither accepts both formats nor
performs a database migration or recovery on behalf of an operator.

The PostCodeFirst migration creates only the typed definition authority tables and their receipt/obligation/idempotency records. It does not create an article-value or property-query store. Runtime table creation and migration catalog entries must stay synchronized with the migration descriptor.

Focused checks:

```bash
node tools/governance/check-article-property-definition-authority.mjs
node --test tests/tools/article-property-definition-authority.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter FullyQualifiedName~ArticlePropertyDefinitionAuthorityTests
```

## Integration and qualification

The remote source is integrated as WIP under #3702, preserving #2322's definition-only scope and acceptance obligations. Source review and focused supplemental tests do not qualify PostgreSQL persistence, the canonical backend suite, or deployment. The canonical suite remains blocked by the existing Migration compilation failures; the historical allowed-extra-table checker also requires migration to its current schema owner. Do not activate or migrate a production database on this source integration alone.

The 20260915 manifest combines the definition authority and existing author-recent-history catalogs in stable execution order. The 20261002 command-history catalog declares both its direct definition-schema dependency and the latest preceding PostCodeFirst descriptor. Offline historical classification facts remain Migration-owned and regenerate the derived catalog through `tools/db/generate-offline-migration-catalog.mjs`; they do not grant current-schema admission.
