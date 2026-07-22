# Integrity Proof Verification

Integrity proof verification is local and deterministic. It does not call IPFS, Arweave, chains, wallets, or external network services.

Start from [IntegrityProof](index.md) (`docs/integrity/index.md`) for the system boundary, threat model, operator runbook, implementation notes, and public verification guide.

## Local Command

Run the canonical backend producer and write the independent logical-tier projection:

```bash
./tools/test.sh integrity-proof-verification
```

`backend-unit` owns the C# verifier tests. The `integrity-proof-verification` tier then runs only `tools/test/project-evidence.mjs` and writes `.tmp/release-evidence/integrity-proof-verification.json`. It does not start a second `dotnet test` or testhost.

## CI Gate

`tests/matrix.yml` defines `integrity-proof-verification` as a fast gate. The lane covers:

- canonical hash fixture
- artifact digest fixture for `ArticleDetailAeds`, `PublicHotRead`, `PublicAOT`, feed and asset manifest outputs
- publish proof signature verification
- transparency log chain verification
- Merkle checkpoint root verification
- Merkle inclusion proof verification
- public key registry verification
- schema migration checks for proof, log and checkpoint storage

## Tamper Matrix

The verifier rejects:

- payload tamper
- signature tamper
- keyId tamper
- algorithm mismatch
- log deletion
- log reorder
- checkpoint tamper

Failure output names the broken layer: hash, signature, log, checkpoint, inclusion proof, or key registry.

## Fixture Updates

Keep fixtures deterministic and model names current. Updates must preserve `articleRevisionId`, `revisionNo`, `ArticleDetailAeds`, `PublicHotRead` and `PublicAOT` naming. Use fixed test keys only; production private keys must never enter fixtures, logs or release evidence.

## Release Evidence

`.tmp/release-evidence/integrity-proof-verification.json` contains:

- `status: success` and `executionMode: projection`
- physical `executionOwner` and `projectFrom`
- exact logical test IDs, concrete source test IDs and coverage IDs
- producer receipt identity and content digest
- source/run/namespace identity
- artifact paths and SHA-256 digests
- an `executionBoundary` with zero `dotnet test`, Vitest, Playwright and runtime probe launches
