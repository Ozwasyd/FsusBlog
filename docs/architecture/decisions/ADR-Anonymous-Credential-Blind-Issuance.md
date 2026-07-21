# ADR: anonymous credentials use RFC 9474 blind issuance

Status: Accepted for issuance; presentation circuit blocked pending a new ceremony
Date: 2026-07-15
Issue: #1136

## Context

The retired circuit-native request exposed a deterministic envelope containing
hashes of client material. Because the issuer received that envelope and signed
it directly, it could recompute or compare issuance material against a later
credential representation. Calling that request "blind" did not provide a
cryptographic blindness property.

The requirement is stronger: the authenticated eligibility service may know
that an account consumed one epoch quota, but it must not see or derive the
final credential signature, credential commitment, revocation handle,
nullifier, or any stable credential subject. The solution must run locally,
without a hosted issuer or privacy SaaS.

## Decision

FsusBlog uses RFC 9474 `RSABSSA-SHA384-PSS-Randomized` with a 3072-bit RSA key
and exponent 65537 for anonymous credential issuance.

1. The public metadata endpoint returns the exact scheme id, key id, SPKI,
   SPKI SHA-256, modulus width, epoch, circuit and layout.
2. The browser constructs the domain-separated credential message, adds a
   random message prefix and 48-byte PSS salt, chooses an invertible RSA blind
   factor, and sends only the 384-byte blinded representative.
3. The server checks authenticated eligibility and one-per-epoch quota, then
   performs only the RSA blind private operation. It applies the public RSA
   operation and constant-time comparison as a fault check.
4. The browser unblinds the response, revalidates SPKI hash/modulus/exponent,
   and verifies the finalized RSA-PSS signature with WebCrypto before creating
   local vault material.

The browser module graph has one composition owner. Pure request/response,
metadata, credential material and suite types live in
`commentPrivacyContracts.ts`, which imports no runtime implementation. The
provider selects and owns the concrete suite and its lifecycle; the Blind-RSA
suite imports only the contracts module and never imports the provider. This
keeps replacement decisions at the composition boundary without introducing a
second suite, fallback, or compatibility provider. Cancellation, malformed
input and cryptographic failures retain the same opaque fail-closed `null`
result, so the wire protocol and caller-visible error mapping do not change.

The protocol id is
`rfc9474-rsabssa-sha384-pss-randomized-3072`. The target presentation contract
is `fsus.anonymous.comment.v5`, public-input layout 6. Non-current
circuit-native Groth16 artifacts are incompatible and cannot be reused.

## Isolation and operations

- The issuer stores only an epoch-scoped HMAC quota subject and an hour bucket.
  It stores no trace, path, identity kind, request, response or credential
  value. Blind issuance does not call the general high-value audit sink.
- The PKCS#8 DER private key is a local file outside public/upload/backup
  boundaries with Unix permissions no broader than 0600. Key-read, exported
  private parameters and per-operation temporary byte arrays are cleared.
- `AnonymousCredentialIssuer:BlindRsa:Enabled` is a reload-aware emergency
  stop. Setting it to false stops metadata and rejects private operations
  without restarting. Enabling an unconfigured signer or rotating its key
  requires a new process and coordinated root metadata.
- Eligibility, ban, quota, malformed input and signature failure share one
  outward error and controlled response-time buckets.

## Ceremony boundary

This decision does not claim a completed v4 Groth16 circuit or trusted setup.
The current checkout has no v4 R1CS, phase-2 transcript, proving key, verifying
key or browser prover that constrains possession of the finalized blind RSA
credential. Production flags therefore remain disabled and all v4 ZK ticket
paths fail closed. A later ceremony must bind a reviewed v4 circuit and publish
real cross-stack/tamper/performance evidence before `production_usable` can be
true.

## Consequences

- The issuer cannot deterministically match an issuance transcript to either
  of two finalized credentials; executable tests assert the complete 2x2
  compatibility matrix.
- Browser computation and credential storage grow because RSA values are 384
  bytes and WebCrypto verification is mandatory.
- Blindness does not hide the fact that an authenticated account requested a
  credential or consumed quota. Network timing, authentication and endpoint
  access remain observable at the issuer; the threat model records that
  residual boundary.
- The old issuance endpoint stays permanently fail-closed with HTTP 410.
- The contract export snapshot and import-boundary checker prevent the provider
  and Blind-RSA implementation from becoming a strongly connected component.
