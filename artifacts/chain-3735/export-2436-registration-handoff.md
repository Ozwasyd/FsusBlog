# Export protocol registration queue

Supplied source `29f89672ef8aa456bd36dca5118fd1a9101adbf5`, branch `codex/export-api-ui-2436-wire-domain-20261008`, has exact parent `81f9e8a14aba3bf39d6f231dd9f91bc4109cd88f`. Its remote SHA and parent were verified. No source from that branch was imported into the current implementation. The [source-bound queue](export-2436-registration-queue.json) binds each relevant Git blob and SHA-256.

| Exact root | Actual Core model | Existing codec suffix | Endpoint complete-frame limit |
|---|---|---|---|
| `DocumentExportRequest` | `DocumentExportRequestCoreModel` | `DocumentExportRequest` | 16,384 bytes |
| `DocumentExportTaskRequest` | `DocumentExportTaskRequestCoreModel` | `DocumentExportTaskRequest` | 1,024 bytes |
| `DocumentExportJobResponse` | `DocumentExportJobResponseCoreModel` | `DocumentExportJobResponse` | Not specified here |
| `DocumentExportPageResponse` | `DocumentExportPageResponseCoreModel` | `DocumentExportPageResponse` | Not specified here |

All four codec suffixes have existing `Encode…`, `Write…`, `TryDecode…` methods in `FsusBlog.Core.Cache.PodBinaryCodec`. The payload revision is 1 over the existing little-endian POD reader/writer with strict UTF-8 byte-length-prefixed strings. The decoder payload cap is 4,194,304 bytes. That cap is distinct from the endpoint's `maxFrameBytes`; the 16-byte outer header means request payload budgets are 16,368 and 1,008 bytes respectively. Response complete-frame/native limits still require the original proposal; no 4 MiB complete-frame limit is inferred.

The source closes page size to 50, attempts to 3, identifiers to 192 UTF-16 code units, reason to 2048, statuses to 1–10 and presence/boolean tags to 0/1. Digests are `sha256:` plus 64 lowercase hex characters, not bare 64-character hex. Int64 identities, revisions and versions need lossless decimal-string frontend binding. Request IDs are existing bounded opaque strings, not an invented Guid contract. Source coordinates are nested in requests and job projections; attempts and outputs are display projections. None gets a standalone frame. Output excludes object paths, owner/session identity, filenames and download capabilities.

The five controlled payload goldens cover all four roots. Source enumeration agrees with the parent's 83 controls: codec 31, binding 21 and endpoints 31. This is static enumeration, not executable verification. Exact tested source/DLL/SDK/run-bound commands, exits and raw results have not been supplied to this environment; those controls are not recorded as Root-passed. The binding's tests explicitly allow an unregistered frame to refuse, so their success cannot itself prove wire activation.

The current canonical manifest has 267 active frames through 275 and existing navigation reservations 276/277. **No Export frame or error ID has been allocated.** The original proposal's exact family labels and native error semantics are absent from the supplied source and available local handoffs. Supply its exact commit/path before numeric reservation, then reconcile it with these real models, codec symbols and limits. Registration must subsequently preserve bounded managed/native/TypeScript, generator and golden parity. It is not HTTP authorization, native download, provider or rendered UI acceptance.

Root #3653 retains freezer, DI and route composition. #2436 retains API/UI and its ordinary independent review. Root #3735 retains the sole protocol/decoder registry. Frame 275 remains published unchanged; this queue does not delay its original owner's consumer regeneration. No whole sibling branch, jobs store, provider or guessed protocol was consumed. The chain remains open with its existing acceptance gates.

Latest read-only master fetch: `1787fe43953a275ee25a481e1eec7c8dbbd5852f`. Changes since `dbb373071db1ad21aaa665f4a1512bfb43f59950` are `artifacts/change-contract/backend-existing-reader-lock-external-naming.json` and `tests/backend/packages.lock.json`; no merge, rebase or upstream implementation consumption occurred. Local review copies and commands are under `.tmp/chain-3735/export-2436-registration/`.
