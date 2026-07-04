# Integrity Proof Verification

Integrity proof verification is local and deterministic. It does not call IPFS, Arweave, chains, wallets, or external network services.

Start from [IntegrityProof](index.md) (`docs/integrity/index.md`) for the system boundary, threat model, operator runbook, implementation notes, and public verification guide.

## Local Command

Run the verifier and write release evidence:

```bash
tools/test/lanes/integrity-proof-verification.sh
```

The lane runs the C# verifier tests with `FullyQualifiedName~IntegrityProofVerification` and writes `.tmp/release-evidence/integrity-proof-verification.json`.

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

- `status`
- `command`
- `fixtures`
- `tamperMatrix`
- `publicModels`
- `externalNetwork: false`
- generated timestamp
