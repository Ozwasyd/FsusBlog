# Admin locale schema source closure

Refs #2299. Original Layout-owned workspaceLayout additions changed three string
leaves in each of the ten canonical admin locales but omitted the corresponding
application schema entry. This repair implements a real reusable static producer
and uses it to update the original entry, without changing words, original runtime
algorithm, focused expectations, frozen SOURCE authority or Main's working tree.

## Freeze assessment

LOCALE_DOMAIN_SCHEMA_DIGESTS is ordinary application source. Its original focused
contract derives the canonical schemas and compares the live table; Object.freeze
and Readonly express runtime immutability, not a permanently frozen admin literal.
The file appears in public-shell finite-input dependency rosters. That registration's
reviewed owner digest, canonical source closure fixture and qualification receipts
are distinct frozen objects: a source repair does not authorize refreshing them.
Their original byte identities, plus the focused contract, are preserved in
source-offer.json. No registration/generator/fixture/receipt refresh ran. Existing
qualification holds remain; this change does not promote any SOURCE authority.

## Original calculation and reusable producer

`tools/frontend/sync-locale-domain-schema.mjs --check|--write --domain admin`
reads the actual canonical locale catalog, original EXPORT_NAMES/schema table,
and every enabled locale's literal admin export/identity. It interprets the closed
literal TypeScript grammar without importing/evaluating product source: type-only
imports, exported const identity/data, ordinary object properties/string leaves,
and transparent const/satisfies wrappers. It rejects duplicate/computed/spread/
method/getter/dynamic data, runtime module statements and identity/schema mismatch.

The static calculation supports the original leafKind/localeDomainSchemaDigest
algorithm only. A compiler-printed AST SHA256 guard refuses calculation drift;
seed/multiplier are read from the validated original BigInt AST literals. Sorted
keys/leaf kinds and FNV1a64 over UTF16 code units match that original algorithm.
Translated values are excluded; plural nodes retain the original plural leaf kind.
This compatibility guard is a local producer constraint, not a second release
SOURCE-authority registration or general JS security proof. Unsupported grammar or
algorithm requires a reviewed producer change, not guessed output or source eval.

All ten literal shapes agree before write. The selected entry is derived, never
supplied by a CLI hash option. Write rechecks its observed inputs and replaces only
that string literal in the original file. No locale catalog value, other domain
entry or runtime function is changed. The original focused contract remains intact.

## Actual source-only results

- Before: `--check --domain admin` actual exit1/FAIL; table d73ace versus derived
 91f19. before-static-check-fail.json retains actual input SHA256, supported algorithm
 AST identity, every locale schema and projected output SHA256.
- Write: actual exit0/PASS changed:true; producer-write.json. Application diff is
 exactly one admin digest string. It is producer output, not a manually supplied hash.
- After: actual exit0/PASS check; second write changed:false and byte fixed point.
- Fourteen static source controls PASS (2 positive/12 negative), including changed
 translations preserving shape, dynamic statements/property forms and algorithm drift.
 Controls parse inert strings; they execute no product/control source.
- Reusable selected-domain check for public (original publicMessages export) PASS
 with all ten schemas agreeing and no source changes.
- Original locale static gate PASS for100 artifacts/10 locales/10 domains. Strict
 repository ESLint0 for producer/control/original table; core/component guards PASS.

Input/output records and minimum consumer patches are pinned in source-offer.json.
The one-line producer source repair patch assumes the existing ten donor catalogs.
The Mainef7 closure patch also adds exactly the original three workspaceLayout keys
to each actual Main locale. The source patches use --unified=0 to avoid context-only trailing spaces in stored
patch artifacts; apply with git apply --unidiff-zero only against the pinned exact
base/preimages. Its13 files are ten locale additions, the original
schema entry and two tools. CHECK/APPLY in isolated /tmp copies of actual Mainef7
preimages produced13 exact donor/new-producer postimages; the genuine static producer
then CHECKed them PASS. No Main/UI/other owner working tree was written.

Recompute with:

```sh
node tools/frontend/sync-locale-domain-schema.mjs --check --domain admin
node tools/frontend/check-locale-domain-schema-source-controls.mjs
```

For a future ordinary schema source change, run the producer with --write for that
domain, review its exact diff, then check again. This is not a command to refresh
frozen fixtures, authority or receipts. Current source-snapshot records remain
historical records, not live qualification receipts.

## Limits

No focused runtime/test/list/discovery, browser/mount/native, geometry, receipt,
tamper/race/security/privacy/IME/resource/fullready qualification or frozen refresh
ran. No full typecheck rerun is claimed for this one literal source change; prior
Layout209 and Main29 are different historical programs. Independent source review
and all existing UI/baseline/complete-application qualification holds remain pending.
