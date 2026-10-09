# Nonce caller contract reconciliation

Prior published head: `397cd89fa6ea41e9af5810af66859ed5fd21ebb4`.
Completed ordinary composition remains bound to
`ab2c589d02fabfa6ed15967f0e58800d2555398a`: 14/14 original-project
controls, no skips or extra cases, as recorded in
[the immutable checkpoint](ab2c589d0/checkpoint.md). Those controls were not rerun
or relabelled as a new candidate result.

The coordinating parent supplied an independent review of the exact two-file
component `c73ab1f4bc6947f9decc3cb488842ccef3412f69`, with no must-fix and
22 focused component cases. This is supplied component review evidence, not a
root rerun, complete repository SOURCE stage, integrated branch approval or
native/caller/lease/flush qualification. Raw SOURCE logs are not published here.

The caller invariants are now explicit in the existing response overload's XML
summary and the maintained repository ownership document:

- Scratch ownership must remain exclusive and stable through completion, and its
  storage must be disjoint from both the template and BodyWriter destination.
  The existing operation hold preserves lifetime; it does not exclude or detect
  aliases. No alias or custody probe was added.
- The supplied adapter calls Encoding.UTF8.GetBytes before the original
  template.Write cancellation check. A valid nonce can therefore modify scratch
  when the token was already canceled. Cancellation promises neither unchanged
  scratch nor immediate pool clearing. The original pool clears only at the
  actual final return according to its existing ownership contract.
- The response overload still invokes the adapter inside ConsumeAsync and awaits
  the original flush path. Existing ordinary callers use a separately rented
  transient buffer and an independent Pipe; no scratch storage is passed as the
  template or destination backing. These fixture constructions are separate
  from production qualification.
- The existing pre-canceled test asserts zero body Advance/Flush and correct
  hold/accounting behavior; it does not assert untouched scratch. Its source is
  unchanged. Template streaming and cancellation ordering are unchanged.

Source locations after this documentation clarification:

| Fact | Source |
| --- | --- |
| Explicit ownership/disjoint/cancellation contract | `src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs:600` |
| Adapter call and original flush under existing hold | `src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs:619` |
| Encoding before original template call | `src/backend/Infrastructure/PublicAot/ReservedCspNonceScratchWriter.cs:30` |
| Ordinary independent pool/Pipe construction | `tests/backend/Unit/CspNonceTransientResponseTests.cs:25` |
| Existing pre-canceled assertions | `tests/backend/Unit/CspNonceTransientResponseTests.cs:104` |
| Original active serving entry | `src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs:666` |

This increment changes only XML comments, architecture contract text and this
reconciliation record. No executable code, test, supplier file, serving call,
pool, budget, template semantics or qualification was changed. Scoped
comment/marker and document/commit checks cover the clarification; no tests,
alias probes, custody audits, native or whole SOURCE stages were run.

Production ServeHtmlWithNonce still lacks a real admitted scratch lease and
pool/budget binding, and continues to use its original overload. All 22 execution
issues and tracking #3468 remain NotAccepted as enumerated in the linked
checkpoint. Production/native/full-stage qualifications remain false. No GitHub
content write, issue closure, merge or deployment is requested.
