# Authoring approval transport boundary

This bounded successor consumes the original approval issuer v2 frozen at
`1647fc9535664ada98b7eccdffe09db240d91acd`. The original namespace, opaque
`ApprovedClaim`, SQL actor/session checks, decision journal, state/lifecycle stores
and refusal behavior remain unchanged. Source custody is recorded in
`artifacts/change-contract/authoring-approval-transport-source-custody.json`.

## Host facts and custody

`AuthoringExtensionApprovalTransport` delegates preparation, reading, explicit
confirmation, denial and revocation to `AuthoringExtensionApprovalAuthority`.
Verified packages, the full exact frozen migration plan, ordered old/new targets,
measurement and expected lifecycle receipt are host inputs, never decoded client
credentials. Confirmation carries only decision ID, the displayed original digest
and the original step-up proof. A decision ID locates a decision; it grants nothing.

The original issuer owns the distinction between manifest payload SHA-256 for
receipt/target identities and compound package identity for snapshots. Migration
claim binds both ordered target rosters. Completion requires the actual execution
result and result receipt; terminal ScopeDigest commits that result's content hash.
The transport provides neither claim nor completion entry points and never encodes
an ApprovedClaim, execution result, state snapshot or native-readiness credential.

Exact scope authorization and original state/native generation/snapshot acceptance
custody are still missing. Their absence retains the original issuer's refusal.
No production DI registration, HTTP route, frontend HTTP request, activation,
migration, snapshot acceptance or execution adapter is added. Wire witnesses and the
source owner's synthetic SQL ACL fixture establish format and refusal behavior;
they do not qualify canonical authorization, native startup or execution acceptance.

## One wire owner

The existing `article-property-value-read-wire.json` and its original wire/golden
producer own the private approval preview, decision-location and explicit-confirmation
roots. Original AEDS protocol generation allocates all frame constants and catalog
entries. C#, TypeScript and production native dispatch use the same closed schema,
8 MiB payload and 40,000 aggregate-item bounds, strict UTF-8, int64 decimal strings
and UTC 100 ns ticks. Unknown versions/discriminants, truncation, trailing bytes,
invalid scope text and inconsistent operation/target shapes refuse.

The preview projects the original operation context, exact scopes, retention,
digest, current durable status, expected lifecycle receipt and ordered targets.
Its plan summary preserves the original full-plan digest, revisions, budgets,
references and transform count while excluding default/state bytes. This summary
cannot replace the full original plan or its owner custody at confirmation.
The frontend helpers only encode bounded commands and decode a registered preview
bound to the located decision. No runtime route or approval flag accompanies them.

## Verification and remaining acceptance

Independent transport tests reuse the frozen owner's isolated PostgreSQL/Redis
fixture without changing its source. They call the actual adapter and issuer and
check durable event counts after SQL permission/session revocation, site mismatch,
user/document scope expansion, missing scope custody, and changed plan, target or
displayed digest. Original source tests retain the missing actual-result custody,
stale receipt and version/schema refusal controls. The current authoring HTTP host
continues to return NotFound for approval paths, including claim and completion.

Full authorization acceptance still requires the canonical scope owner and original
state/native/snapshot owners to implement and independently verify their custody
contracts. Such work must precede production composition or positive runtime use.


## Original scope text parity

Approval ScopeView fields use the frozen state owner's `ValidateScope` and
`IsField` semantics: nonempty text, original UTF-16 code-unit length limits
(128 for extension ID, 64 for extension version, 256 for site/user/document),
.NET trim boundaries, no control characters and no UTF-16 surrogate code units.
Consequently even well-formed supplementary Unicode, including emoji, is refused
in these fields. Optional document null remains valid. BMP format/noncharacter
scalars and combining forms retain exactly the original owner's behavior; transport
does not impose normalization or a new opaque-user policy.

The existing schema identifies the frozen predicate owner. The original producer
checks that predicate and limits before generation, emits the same C# predicate,
and aligns TypeScript/native validation with it. Shared witnesses compare actual
C# `ValidateScope` with generated encoders/decoders, frontend registry and production
native dispatch for Unicode classes, malformed UTF-8 and length boundaries.
The generic property scope codec retains its supplementary-Unicode behavior.
These are text/format checks and provide no runtime authorization or owner custody.
