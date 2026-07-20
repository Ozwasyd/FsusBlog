# PerceptionCharacterV3 protocol

This document is the normative mathematical and security specification for the server-rendered character challenge. The machine-readable constants and atlas are in [`perception-character-v3-contract.json`](../../src/shared/Contracts/Validation/Security/perception-character-v3-contract.json). The executable reference and language-neutral vectors are in [`perception-character-v3-reference.mjs`](../../tools/contracts/perception-character-v3-reference.mjs) and [`perception-character-v3-vectors.json`](../../tests/fixtures/security/perception-character-v3-vectors.json).

This issue defines a protocol, not a UI or production provider. A later implementation must consume these artifacts byte for byte.

## Identity and compatibility boundary

The only V3 identity is:

| Property | Exact value |
| --- | --- |
| enum | `PerceptionCharacterV3` |
| wire name | `perceptionCharacterV3` |
| algorithm | `fsu.challenge/perception-character-raster@v3` |
| protocol version | unsigned byte `3` |

There is no alias, parser branch, fallback, or migration path from any retired identity. A request carrying any other identity is not this protocol. Numeric frame allocation and the typed AEDS union belong to the implementing issue; a V2 frame or dictionary payload must not be reinterpreted as V3.

The public issue payload may contain only the exact identity, challenge and envelope IDs, representation (`visual` or `audio`), final bounded media bytes and media type, physical/display dimensions, attempt budget `2`, issue/expiry times, coarse policy version, and an opaque state token. It must not contain the answer, answer tag, glyph or atlas index, raster seed, render recipe, affine parameters, displacement lattice, curve/occluder/noise parameters, audio phonemes/order, key material, exact risk score, or an unkeyed token digest/signature.

## Answer space and normalization

The ordered alphabet is

```text
Σ = ACDEFGHJKMNPQRTUVWXY234679
```

`|Σ| = 26`, answer length `n = 5`, answer space `|Σ|^n = 26^5 = 11,881,376`, and entropy is `log2(26^5) = 23.50219859070546` bits.

Each of the five positions is sampled independently from a cryptographic random byte stream. For each byte `b`, accept it only when `0 <= b < 234`, because `234 = floor(256 / 26) * 26`; an accepted byte selects `Σ[b mod 26]`. Bytes `234..255` are discarded. Sampling continues until five symbols have been accepted. Therefore each symbol has exactly nine preimages among accepted bytes and probability exactly `1/26`. Direct `b mod 26`, weighted selection, and reuse of a discarded byte are forbidden.

Normalization is exactly:

```text
N(x) = ASCIIUpper(RemoveASCIIWhitespace(x))
```

`RemoveASCIIWhitespace` removes only code points `U+0009..U+000D` and `U+0020`. `ASCIIUpper` maps only `a..z` to `A..Z`. It performs no locale mapping, Unicode normalization, full-width conversion, or confusable folding. After normalization, the result must contain exactly five Unicode scalar values and every value must be one of `Σ`; otherwise verification is a failed attempt.

Client-reported solve duration does not exist in the V3 wire contract. Server-observed elapsed time is telemetry/risk evidence only and cannot accept or reject an answer by itself.

## Canonical byte encoding

`EncodeLP(fields)` is the only canonical encoding used below:

1. Emit the field count as unsigned 16-bit big-endian.
2. For every field in the listed order, emit its byte length as unsigned 32-bit big-endian, then the exact field bytes.
3. Text uses strict UTF-8 without a BOM unless a field below is explicitly ASCII. Invalid Unicode scalar sequences are rejected; strings are not trimmed or normalized unless the field rule says so.
4. `version` is one unsigned byte `03`; `attemptBudget` is one unsigned byte; Unix milliseconds are signed 64-bit big-endian.
5. Hash/tag fields are decoded from exactly 64 lowercase hexadecimal characters to 32 raw bytes before encoding. IDs, action, route and policy version remain their validated UTF-8 wire strings.

An empty sequence encodes as `0000`; one empty field encodes as `000100000000`. The vector fixture covers lengths 255 and 256 and proves that reversing fields changes the digest. Field names are descriptive only and are not emitted; order is part of the protocol.

## Answer authentication

Each answer key is exactly 256 bits and has an independently rotated `answerKeyVersion`. Define:

```text
domain = UTF8("fsus.perception-character.answer")
tag = HMAC-SHA-256(K_answer[answerKeyVersion], EncodeLP(
    domain,
    0x03,
    UTF8(challengeId),
    UTF8(envelopeId),
    UTF8(action),
    UTF8(routeKey),
    HEX32(subjectHash),
    HEX32(deviceBindingHash),
    UTF8(policyVersion),
    HEX32(mediaHash),
    ASCII(N(answer))))
```

The server compares the 32-byte stored and computed tags with a fixed-time primitive. It performs a fixed-size comparison even for malformed input and separately rejects a non-32-byte candidate. The tag is encrypted state and is never public.

The HMAC deliberately authenticates the candidate without publishing an offline oracle. The 11,881,376-answer space is enumerable, but a client lacking `K_answer` cannot validate an enumeration against the token or media. The visible raster can still be attacked by OCR; that is residual online/media-solving risk, not offline cryptographic validation.

## Key rings and startup validation

Token and answer keys use separate named rings and separate current-version selectors. Every key is exactly 32 bytes from an external secret source. Startup fails before serving traffic when any of these conditions holds:

- a current selector is missing, invalid, or absent from its ring;
- a ring is missing or a key is shorter/longer than 32 bytes;
- any token key has the same bytes as any answer key, including non-current rotation entries;
- a key equals a repository placeholder, a known development key, or a checked-in test-vector fingerprint;
- a version is not 1–64 ASCII letters, digits, `.`, `_`, or `-`.

The checked-in vector keys may be accepted only by an explicit `environment=Test && allowTestVectors=true` reference-test path. They must be rejected in every deployed environment. Key bytes are never logged, returned, stored with challenge state, or used for both functions. Implementations should zero temporary answer/key/plaintext buffers as soon as their platform permits.

## Authenticated encrypted state

State uses AES-256-GCM with the selected token key, a fresh cryptographically random 96-bit nonce for every seal, and a 128-bit authentication tag. Nonce reuse under one key is forbidden. Deterministic nonce injection exists only for fixture tests.

AAD is `EncodeLP` in this exact order:

```text
ASCII("PerceptionCharacterV3")
ASCII("perceptionCharacterV3")
ASCII("fsu.challenge/perception-character-raster@v3")
0x03
UTF8(challengeId)
UTF8(envelopeId)
UTF8(action)
UTF8(routeKey)
HEX32(mediaHash)
INT64BE(issuedAtUnixMs)
INT64BE(expiresAtUnixMs)
ASCII(tokenKeyVersion)
```

Plaintext is `EncodeLP` in this exact order:

```text
BYTES32(answerTag)
HEX32(mediaHash)
UTF8(challengeId)
UTF8(envelopeId)
UTF8(action)
UTF8(routeKey)
HEX32(subjectHash)
HEX32(deviceBindingHash)
HEX32(clientIpBindingHash)
UTF8(policyVersion)
UINT8(2)
ASCII(representation)
INT64BE(issuedAtUnixMs)
INT64BE(expiresAtUnixMs)
ASCII(tokenKeyVersion)
ASCII(answerKeyVersion)
```

The opaque token bytes are:

```text
03 || UINT16BE(len(tokenKeyVersion)) || ASCII(tokenKeyVersion)
   || nonce[12] || ciphertext[n] || gcmTag[16]
```

They are encoded as unpadded Base64url. The clear key version is selection metadata and is authenticated again in AAD and plaintext. Unknown versions, malformed Base64url, truncation, AAD mismatch, or tag failure are rejected before plaintext is used. There is no separate `SHA256(token)` signature or other unauthenticated integrity field.

The media binding is `mediaHash = SHA-256(exact media bytes)`. For visual media those bytes are exactly the row-major 98,304-byte Gray8 raster, not a PNG re-encoding. An implementation may transport a separately specified lossless envelope only if its typed AEDS contract binds and validates the exact decoded Gray8 hash defined here.

## Visual raster

### Fixed surface and atlas

The physical raster is `512 x 192` Gray8, row-major, stride 512, with `0` black and `255` white. Its display box is `320 x 120`; display scaling never changes the authenticated physical bytes.

The approved atlas is public and deterministic. `glyphAtlasBaseRows` in the machine contract contains one 5-by-7 binary mask for every symbol in `Σ`. It is centered at offset `(1,1)` in a 7-by-9 cell. The six ordered `glyphVariantOffsets` stamp every set base bit at these offsets:

```text
0: (0,0)
1: (0,0), (1,0)
2: (0,0), (0,1)
3: (0,0), (1,0), (0,1)
4: (0,0), (-1,0), (0,1)
5: (0,0), (0,-1), (1,0)
```

Thus every symbol has exactly six approved variants. Each atlas pixel occupies a 10-by-10 source-pixel square, making the local glyph box 70 by 90 pixels centered at `(0,0)`. Atlas data is not secret and is never sent as challenge metadata.

### Server-only random stream

The runtime seed is 32 random bytes retained only during server rendering. The deterministic parameter stream is consecutive blocks:

```text
HMAC-SHA-256(rasterSeed,
    ASCII("fsus.perception-character.raster.v3") || 00 || UINT32BE(counter))
```

starting at counter zero. Read unsigned 32-bit big-endian candidates. To sample inclusive integer range `[a,b]`, let `s=b-a+1`, accept only candidates below `floor(2^32/s)*s`, and return `a + candidate mod s`. This is also unbiased rejection sampling. The seed and all derived parameters remain server-only.

### Glyph layout and affine transform

The first glyph source origin is `x=52`; subsequent origin is `origin_i + 82 - overlap_i`. For glyphs 0–3, `overlap_i` is an independent integer in `[4,16]`; the fifth glyph does not advance. Nominal center is `(origin_i+35, 96)`.

For every character independently derive: atlas variant `[0,5]`, translation `tx in [-12,12]`, `ty in [-10,10]`, rotation `theta in [-14,14]` integer degrees, horizontal shear `h in {-0.18,-0.17,...,0.18}`, scale `sx in {0.90,...,1.12}`, scale `sy in {0.92,...,1.14}`, baseline offset `b in [-8,8]`, overlap, and ink Gray8 `[0,64]`.

Using column vectors, the transform is exactly:

```text
A_i = T_i * R_i * H_i * S_i
S_i = [[sx, 0, 0], [0, sy, 0], [0, 0, 1]]
H_i = [[1, h, 0], [0, 1, 0], [0, 0, 1]]
R_i = [[cos(theta), -sin(theta), 0], [sin(theta), cos(theta), 0], [0, 0, 1]]
T_i = [[1, 0, origin+35+tx], [0, 1, 96+ty+b], [0, 0, 1]]
```

Rasterization iterates destination pixel centers `(x+0.5,y+0.5)`, applies `A_i^-1` in the exact operation order in the reference module, and selects the source atlas cell by floor division at 10 pixels. Covered pixels take `min(currentGray, inkGray)`. Calculations use IEEE-754 binary64, round-to-nearest ties-to-even for primitive operations; explicit `floor`, `ceil`, and `round` sites follow ECMAScript semantics. Iteration is glyph order, then increasing `y`, then increasing `x`.

### Curves, occluders, displacement, and noise

After glyphs, derive 2–5 quadratic Bézier interference curves. Endpoints are `x0 in [0,96]`, `x2 in [415,511]`, `y0,y2 in [16,175]`; control is `x1 in [176,336]`, `y1 in [0,191]`; radius is `[1,3]` and gray `[32,144]`. Evaluate `B(t)=(1-t)^2 P0+2(1-t)t P1+t^2 P2` for `t=k/256`, `k=0..256`, round coordinates, and stamp every integer point inside the closed radius disc with `min` compositing.

Then derive 1–3 elliptical occluders. Center is `x in [24,487]`, `y in [20,171]`; width `[8,28]`, height `[6,20]`, gray `[72,184]`. A destination integer point is covered when `((x-cx)/(w/2))^2 + ((y-cy)/(h/2))^2 <= 1`, again using `min` compositing.

The displacement field has a fixed 9-column by 5-row control lattice. Every control component is an independent integer in `[-7,7]`, so vector magnitude is at most `sqrt(7^2+7^2) = 9.899494936611665` pixels. Map raster coordinate `(x,y)` to lattice coordinate `(8x/511,4y/191)`. Clamp the four neighboring indexes at the lattice edge and interpolate each component first across x and then y using Catmull–Rom:

```text
CR(p0,p1,p2,p3,t) = 0.5 * (2p1 + (-p0+p2)t
    + (2p0-5p1+4p2-p3)t^2 + (-p0+3p1-3p2+p3)t^3)
```

The output at `(x,y)` bilinearly samples the pre-warp raster at `(x-Dx,y-Dy)`; outside is 255. Bilinear output is `floor(value+0.5)`, clamped to `[0,255]`.

Finally add independent integer noise `[-12,12]` to every pixel and clamp. Derive an impulse count `[256,768]`; for each impulse choose a flat pixel index uniformly and set it to 0 or 255 uniformly. Duplicate indexes are allowed and still count against the bound. No request controls dimensions, atlas complexity, lattice size, curve/occluder count, noise count, or any range.

The exact generation order, PRF consumption order, atlas digest, raster seed, raster byte count, and media hash are fixed in the cross-language vector. Two implementations that follow the operation order produce the same 98,304 bytes.

## Audio representation

Audio is separately issued server-final media. The client receives no phoneme, character ordering, voice-unit, timing, synthesis seed, or mixing recipe. Duration, sample rate, channel count, codec, byte count, synthesis concurrency, and timeout are fixed bounded server policy owned by the implementation issue.

Visual-to-audio or audio-to-visual switching is not a mutation of one challenge. The server first atomically revokes the active identity and then issues a new challenge ID, envelope ID, token, nonce, media hash, answer, state row, and attempt counter for the other representation. The old challenge remains revoked if replacement issuance fails. It cannot donate attempts or a state token to the replacement.

## Atomic state machine

The authoritative state is one of:

```text
active -> consumed | exhausted | expired | revoked
```

Terminal states never transition. Each challenge has exactly two verification attempts. One Redis Lua script or a proven linearizable CAS must validate the current state and bindings, compare time, increment the attempt count, and apply at most one transition atomically:

| Current/event | Attempts after | New state | Public result |
| --- | ---: | --- | --- |
| active, unexpired, correct | `old+1` | consumed | success |
| active, unexpired, wrong, first attempt | 1 | active | `retryable` |
| active, unexpired, wrong, second attempt | 2 | exhausted | `rejected` |
| active, `now >= expiresAt` | unchanged | expired | `reissueRequired` |
| active, revoke/cancel/switch | unchanged | revoked | `reissueRequired` |
| any terminal, verify/replay | unchanged | unchanged | `rejected`, except expired/revoked use `reissueRequired` |
| storage unavailable/timeout/ambiguous result | unchanged from caller's perspective | fail closed | `unavailable` |

The atomic operation must not permit two correct requests to succeed, a correct request after a losing incorrect request to exceed two total attempts, two incorrect requests to record one attempt, or retry after an ambiguous Redis result. Challenge identity is the idempotency/serialization key; all bindings and the token ciphertext hash may be checked internally but are not alternate state identities.

Concurrent tests must exercise both request orderings for correct/correct, correct/incorrect, and incorrect/incorrect, plus replay, expiration, revocation, and Redis failure. A normal policy publication does not rewrite the recorded issue policy version; explicit revocation does.

## Public failures and audit

The public protocol exposes only four low-cardinality classes:

- `retryable`: one wrong attempt remains;
- `reissueRequired`: expired or revoked identity; obtain a new challenge;
- `unavailable`: Redis, renderer, crypto service, bounded queue, or dependency failure;
- `rejected`: malformed, tampered, binding-mismatched, replayed, consumed, or exhausted terminal submission.

Mapping depends on recoverability/state, not on which cryptographic comparison, parser field, binding, Redis command, or rate-limit bucket failed. Responses never distinguish bad tag from action/route/subject/device/IP/media/policy substitution. Internal reason, key version, exception, and rate-limit dimensions remain structured audit-only data with secret fields redacted.

## Threat model and invariants

| Threat | Required control and remaining risk |
| --- | --- |
| Client source inspection | Client code sees only public identity and final media. Atlas and algorithm may be public; no answer oracle, seed, recipe, or state plaintext is shipped. Security does not rely on obscurity. |
| Offline enumeration | The small answer space can be enumerated, but no public field validates a candidate: the tag needs a secret answer key and the token is authenticated encryption. Media-based OCR remains possible. |
| Media/answer substitution | `mediaHash` is in answer MAC, AAD, encrypted state, and state validation. A candidate from different media cannot authenticate. |
| Token tampering | AES-GCM authenticates ciphertext and all AAD. There is no malleable or unkeyed companion signature. |
| Replay/concurrency | Linearizable state gives one consuming success and a hard two-attempt ceiling across instances. Ambiguous Redis failure fails closed. |
| Route/action/subject/device/policy swapping | Answer MAC, AAD/state, and authoritative Redis binding cover the relevant values. IP binding is encrypted state/Redis binding. Policy uses the issued version. |
| Refresh flooding/render exhaustion | Independent IP, server-device, subject, action, and active-identity limits run before render/crypto; global render semaphore and bounded queue reject overload as `unavailable`. Constants are not request-controlled. |
| Distributed low-rate guessing | Two attempts per identity, identity-bound state, issuance rate limits, risk aggregation, audit, and policy escalation raise cost. They cannot make a 23.5-bit human answer a high-entropy credential. |
| OCR/model solving | Distortion, variants, displacement, interference, and noise raise automated solving cost but are not a proof of humanity. Model benchmarks and rotation remain required operational controls. |
| Human-solving services | Binding, short expiry, revocation, rate limits, and telemetry limit transfer/reuse but cannot eliminate real-time relay to a human. |

The central invariant is: no public field permits deterministic reconstruction of the answer or offline validation of a candidate answer. The raster necessarily contains perceptual evidence for a human, so OCR resistance is only a cost-raising control.

## Local conformance

Run the external-service-free specification suite:

```bash
node tools/contracts/generate-perception-character-v3-vectors.mjs --check
node --test tests/security/perception-character-v3-spec.test.mjs
```

The suite covers identity/negative aliases, ASCII normalization, exact rejection balance, a seeded chi-squared property, empty/boundary/order LP vectors, HMAC and AES-GCM vectors, AAD substitution/tamper, key validation, 156 atlas variants, byte-identical raster hash, nonce uniqueness, atomic-state scenarios, coarse failure behavior, and representation switching. The production implementation must add Redis integration and startup tests; these specification tests require no external service.
