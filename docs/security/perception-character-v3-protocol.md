# PerceptionCharacterV3 final-media protocol

This is the normative security and byte-level specification for the breaking in-place
redefinition of `PerceptionCharacterV3`. Machine-readable constants live in
[`perception-character-v3-contract.json`](../../src/shared/Contracts/Validation/Security/perception-character-v3-contract.json);
the repository-contained reference and language-neutral vectors live in
[`perception-character-v3-reference.mjs`](../../tools/contracts/perception-character-v3-reference.mjs)
and [`perception-character-v3-vectors.json`](../../tests/fixtures/security/perception-character-v3-vectors.json).
The reference-test path is deterministic and uses no external service.

## Identity and compatibility boundary

| Property | Canonical value |
| --- | --- |
| enum | `PerceptionCharacterV3` |
| wire | `perceptionCharacterV3` |
| algorithm | `fsu.challenge/perception-character-artifact@v3` |
| version byte | `03` |

<!-- retired-v3-history:start -->
The former `fsu.challenge/perception-character-raster@v3` algorithm,
`application/x-fsus-gray8` media, `512 x 192` dimensions, 98,304-byte payload,
`audio/wav` representation, `mediaHash`, HMAC/AAD/state layouts and vectors are
retired. They are rejected, never interpreted. There is no V4, alias, feature flag,
dual decoder, migration adapter or compatibility parser. Rollback may remove V3 from
the hot RiskControl policy; it may not restore the retired contract.
<!-- retired-v3-history:end -->

The public issue payload is limited to algorithm, challenge/envelope identity,
representation, final media type and bytes, physical/display dimensions, attempt
budget, coarse policy version, timestamps and opaque state token. It never exposes
answer/tag, glyph or atlas index, seed, recipe, path, affine matrix, displacement
field, noise program, phonemes/order, key material or candidate oracle.

## Answer and canonical encoding

The ordered alphabet is `ACDEFGHJKMNPQRTUVWXY234679`; answer length remains five:
`26^5 = 11,881,376`. Sampling accepts random bytes below 234 and selects
`alphabet[b mod 26]`; bytes 234..255 are discarded. Normalization is exactly
`ASCIIUpper(RemoveASCIIWhitespace(x))`, where only U+0009..U+000D and U+0020 are
removed and only `a..z` are uppercased.

`EncodeLP(fields)` emits a uint16 big-endian field count, then for each field a
uint32 big-endian byte length and exact bytes. Text is strict UTF-8 without BOM;
hash fields are exactly 32 bytes decoded from 64 lowercase hex characters. Field
order is security-significant and is fixed by the machine contract.

## Final visual artifact

The transported visual media is the exact deterministic PNG byte string:

| Property | Value |
| --- | --- |
| media type | `image/png` |
| physical | `384 x 144` |
| display | `320 x 120` |
| PNG IHDR | bit depth 4, color type 0 grayscale, no alpha |
| compression/filter/interlace | zlib DEFLATE level 9 / filter 0 / none |
| hard limit | 32 KiB (`32768` bytes) |

Generation order is answer sampling, glyph placement, affine transform, interference
curves, occluders, bicubic displacement, structured cell bias, 4-bit quantization,
row packing, PNG framing. Glyph/transform/displacement/occlusion inputs remain
server-only. The canonical ranges remain those in the machine contract and reference;
coordinates are evaluated in IEEE-754 binary64 and pixels use row-major order.
Affine composition remains `A_i = T_i * R_i * H_i * S_i`; the displacement lattice
uses the specified Catmull–Rom bicubic interpolation before bilinear raster sampling.

Independent full-raster additive noise and impulses are forbidden. Structured noise
uses a `16 x 12` grid of `24 x 12` pixel cells. Each cell independently samples one
level bias from `{-1,0,1}` using the same unbiased deterministic stream, then:

```text
level(x,y) = clamp4(round(gray8(x,y) * 15 / 255)
                    + bias[floor(y/12)][floor(x/24)])
```

The bias is constant across a cell, bounded to one 4-bit level and never transported.
It preserves low-frequency interference while limiting entropy. Each scanline starts
with PNG filter byte zero; two pixels are packed high nibble then low nibble.
The zlib stream uses deterministic level-9 DEFLATE and Adler-32; stored-only DEFLATE
is retired because it cannot satisfy the release percentile budgets. PNG chunks are
exactly `IHDR`, one `IDAT`, then `IEND`, each with IEEE CRC-32.

## Final audio artifact

Audio is exact final mono Opus in Ogg, never PCM/WAV or a speech recipe:

| Property | Value |
| --- | --- |
| media type | `audio/ogg; codecs=opus` |
| channels | 1 |
| input sample rate | 48000 Hz |
| pre-skip | 312 samples |
| mapping family | 0 |
| output gain | 0 Q8 |
| frame duration | 20 ms |
| encoder application | VOIP |
| bitrate / VBR | 16000 bit/s / disabled |
| complexity | 5 |
| hard limit | 48 KiB (`49152` bytes) |

The pool builder must emit one BOS `OpusHead` page, one `OpusTags` page, then audio
pages with monotonically increasing sequence/granule positions and a single EOS.
Every page has Ogg CRC-32. The answer utterance, pauses, voice selection and encoder
input remain server-only; only completed Ogg bytes cross the public boundary.
The checked-in audio vector fixes container/header/hash validation; production pool
fixtures additionally prove decode duration and answer audibility.

## Artifact binding and state

`artifactHash = SHA-256(exact transported final-media bytes)`. It is not a hash of a
decoded raster, PCM, recipe or re-encoding. Answer authentication is:

```text
HMAC-SHA-256(K_answer, EncodeLP(
  "fsus.perception-character.answer", 03,
  challengeId, envelopeId, action, routeKey,
  subjectHash, deviceBindingHash, policyVersion,
  artifactHash, representation, mediaType,
  physicalWidth, physicalHeight, displayWidth, displayHeight,
  normalizedAnswer))
```

AES-256-GCM AAD order is enum, wire, algorithm, version, challengeId, envelopeId,
action, routeKey, artifactHash, representation, mediaType, physicalWidth,
physicalHeight, displayWidth, displayHeight, issuedAt, expiresAt, tokenKeyVersion.
Plaintext order is answerTag, artifactHash, mediaType, physicalWidth, physicalHeight,
displayWidth, displayHeight, challengeId, envelopeId, action, routeKey, subjectHash,
deviceBindingHash, clientIpBindingHash, policyVersion, attemptBudget, representation,
issuedAt, expiresAt, tokenKeyVersion, answerKeyVersion. The same artifact hash,
representation, media type and dimensions are checked by the typed AEDS payload,
authoritative Redis state and verification path. HMAC-SHA-256 and AES-256-GCM keys
remain separate versioned 256-bit rings.

Every identity has exactly two attempts and follows:
`active -> consumed | exhausted | expired | revoked`. Public failures remain
`retryable`, `reissueRequired`, `unavailable`, and `rejected`. Redis failure or
ambiguous mutation fails closed.

## Encrypted one-time artifact pool

Public issuance never invokes the reference rasterizer, audio builder, PNG encoder or
Opus/Ogg encoder. Operators create an immutable generation before deployment:

```bash
FSUSBLOG_V3_POOL_KEY='<external 32-byte key>' node tools/security/perception-character-v3-pool.mjs generate \
  --root /srv/fsusblog/perception-v3-pools --generation '<generation-id>' \
  --key-env FSUSBLOG_V3_POOL_KEY --key-version '<key-version>' \
  --visual '<count>' --audio '<count>'
FSUSBLOG_V3_POOL_KEY='<same key>' node tools/security/perception-character-v3-pool.mjs validate \
  --root /srv/fsusblog/perception-v3-pools --generation '<generation-id>' \
  --key-env FSUSBLOG_V3_POOL_KEY
```

The packfile is a contiguous sequence of independently AES-256-GCM authenticated
records. Each record contains its random internal ID, generation, representation,
media type, exact final artifact bytes/hash, normalized answer, contract digest and
offline-generator identity. The v1 manifest has an additive exact-byte field and
contains only offset/ciphertext length,
exact final-artifact byte count, nonce, ciphertext digest and non-secret
representation metadata; it contains neither answer
nor media bytes. `Security:PerceptionCharacterV3:Pool:*` selects the immutable root,
active generation and dedicated key ring, which must be disjoint from JWT, answer,
token, PoW and audit keys.

Audio entries are built only by this offline command from the repository-owned,
golden-verified spoken atlas. The command compiles the repository-owned
`perception-character-v3-opus.c` helper with `cc` against host `libopus.so.0`, uses
the fixed contract profile, and fails before publishing the generation when either
prerequisite is unavailable. Generation writes to a private staging directory,
validates every record, then atomically renames it to the immutable generation name.

Startup authenticates every record and rejects unknown contract digests, wrong keys,
duplicate IDs, overlapping/truncated offsets, invalid artifacts and revoked
generations before traffic. Runtime loads only the compact manifest index. Redis
stores one small `burned` marker per leased entry plus generation revocation state;
it never stores media ciphertext/plaintext or answers. A single Lua `SET NX` burns an
entry before packfile read and response delivery. Cancellation, connection loss,
codec/state failure or an ambiguous Redis reply never returns the entry to ready and
never tries online rendering. The decrypted five-byte answer is held only by the
lease, used directly for request-bound HMAC, then zeroed on every exit.

## Validation and negative vectors

Language-neutral vectors cover final visual/audio bytes and hashes, HMAC, AAD,
plaintext, AES-GCM token, field-order changes and size boundaries. Negative tests
mutate PNG signature/IHDR/bit depth/color/alpha/dimensions, Ogg capture pattern,
OpusHead fields, media type, exact hard limits, artifact hash, AAD order and token.
They also reject every retired identity, representation, layout and vector.

Malformed final media is rejected before provider verification. Repository governance
must find no public truth-bearing intermediate and no retired runtime branch.
Perceptual media remains susceptible to OCR/audio recognition and
`Distributed low-rate guessing`; it is not a proof of humanity. Online rate, policy and state
controls remain mandatory.

## Operational rollback

The no-restart rollback is to remove `perceptionCharacterV3` from reloadable
RiskControl policy and revoke active identities. Other challenge kinds,
authentication, admin authorization, notification stream and binary routing remain
enabled. Re-enablement requires a current artifact pool, keys and contract-vector
evidence; restoring the retired representation is prohibited.

Production activation is one release-fenced transaction. Its target map binds the
generated contract digest, exact pool generation and manifest digest, identical
backend/shared/frontend AEDS schema fingerprints, active policy version, release,
slot and deployment generation. The service closes issuance, revokes former V3
envelopes and namespaces without transforming them, retires non-target pool
generations, persists an idempotent hashed receipt, then reopens only after the
current receipt/pool/policy/fence smoke succeeds. A mixed or partial target remains
closed. Retry never leases an artifact and never repeats mutation accounting.
