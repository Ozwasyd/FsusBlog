# Historical GPU/peer source evidence

This source handoff does not qualify a backend, establish performance, accept an issue, approve a held QA scope or authorize a merge. It accompanies exclusive issues3460 and3462. The central coordinator must publish the locally prepared draft PR after the GitHub content-creation limit is released.

## Candidate and scope

- Actual latest master fetched at task start: `b9c076e4b763130075218ff9d50f9a6c36784f59`.
- Tested source: `f4836b86c3132a1b1f41518ff753d80cdc35bd15`, tree `60d9fd46d03b4eb1cf1898bb6255731e07deb3cd`.
- Final candidate branch: `codex/mem-3460-3462-gpu-candidate`; narrow incremental source commits are published. The prior `codex/mem-3460-3462-gpu` branch is preserved, including evidence-only commit40e3f64fb with an invalid Refs footer. This new candidate copies those exact evidence bytes with a corrected footer; it does not rewrite published history. No master push, force-push or merge.
- Seven prerequisite blobs match exact `089d95e466c23a7fc781d30b80157cb4dd199c10`, PR3845. No shared source was altered and no broad WIP merge occurred.
- Distinct source scope: `Memory/Devices/Gpu*.cs`, `Memory/Platform/Gpu*.cs`, `tests/backend/Unit/Gpu*Tests.cs`. Auxiliary artifacts belong only to this partition. Full source diff is [source.patch](source.patch); all 29 source/test bytes are bound in [source-digests.sha256](source-digests.sha256).
- Production remains inactive. The common governor, capability authority, ledger, residency publisher, eligibility/revocation, miss/fallback and inventory/oracle owners retain their responsibilities.

## Current checks

| Check actually executed | Result | Evidence and limit |
| --- | --- | --- |
| `dotnet test /tmp/mem-gpu-tests/GpuTests.csproj --no-restore --logger 'trx;LogFileName=source-f4836b86.trx'` | PASS,102 tests,0 failures/skips | [Raw log](unit-test.log), [TRX](unit-test.trx). Ordinary unit simulations of exact linked production/test source; no native hardware qualification. All source digests remained unchanged across execution. |
| `dotnet build src/backend/FsusBlog.Server.csproj --no-restore -p:PublishClientAssets=false` | PASS,0 errors,323 warnings | [Raw log](backend-build.log). No warnings in changed Memory source; retained warnings are elsewhere in the repository. Prior source baseline log is [retained](backend-build-baseline.log). |
| `dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --source /workspace/.setup/nuget --ignore-failed-sources` | FAIL,offline dependency gaps | [Raw log](offline-restore-failure.log). Missing coverlet.collector and Microsoft.AspNetCore.TestHost; unavailable IdentityModel.Protocols/OpenIdConnect/JWT8.2.0 (cache nearest8.0.1). No dependency downloaded. Full owning backend-test project was NOT run. |
| `node tools/governance/check-change-contract.mjs --range origin/master..HEAD` at tested source | PASS | [Raw log](change-contract.log); not a PR-metadata, independent review or merge approval. |
| `node tools/dotnet/check-csharp-style.mjs --mode changed --base origin/master` | FAIL,45 native delegate return-token diagnostics | [Raw log](csharp-admission-failure.log). Existing checker reads return keywords int/nint/void/ulong/byte as type names; declarations and delegate names follow the language/ABI. No checker/policy/baseline edits or bypass. Required static admission remains blocked. |
| `node tools/run-test-matrix.mjs ci-pr-plan --base-ref origin/master --out /tmp/mem-gpu-pr-plan-f4836b86.json` | FAIL,execution-authority parser drift | [Raw log](pr-plan-failure.log), [earlier unchanged authority failure](pr-plan-earlier-source-failure.log). No applicable-plan output was produced; broad required matrix checks were NOT run or waived. |
| Repository whitespace formatter, exact task-owned source/test paths | PASS,workspace-load warnings for incomplete test dependencies | [Source log](formatter-source.log), [test log](formatter-tests.log). Explicit path filtering prevented edits to shared source. |
| `git diff --check`; seven-common-blob equality; source digests before/after final checks | PASS | Exact source/test blobs are retained. Evidence-only additions do not alter tested code. |
| Native/platform/benchmark/Docker acceptance | NOT RUN / NotVerified | [Platform census](platform-census.log): Linux x64, no exposed DRI/NVIDIA/KFD nodes; installed HIP.so.5 is outside implemented HIP6 profile. No CUDA/macOS hardware proof. Docker was prohibited and not executed. |

Toolchain: SDK10.0.401/net10.0, cached xunit2.9.3, Microsoft.NET.Test.Sdk18.5.1, VS runner3.1.5. The temporary project only links ordinary tests from the owning backend project and the exact actual C# source; it is not a repository test runner, matrix replacement or receipt producer. Its actual [project text](isolated-test-project.csproj.txt) and [offline restore](isolated-offline-restore.log) are retained.

## Implemented source behavior

CUDA12/HIP6 Linux x64 adapters bind actual installed-library symbols, calling conventions, widths, APIs and explicit finite device/loader policy. Metal binds macOS14 exact OS/x64-or-ARM64 policy, approved framework/runtime paths and actual Objective-C selectors; private handles remain opaque, shared staging uses legitimate MTLBuffer.contents. Driver allocation/copy/peer functions are real C# native adapters; fake dispatch is used only by labeled unit tests. Metal allocatedSize is observed separately and never fabricates a ledger grant.

The common ledger charges driver-valid host staging once, including its containing host capacity, registration subset and transfer slots. UMA aliases do not create extra host headroom. Both peer slot domains are reserved atomically through the SAME coordinator. Pool retention stays charged. Source read holds are bounded across the whole device. Complete byte copies, content identity, immutable initialization and exclusive unpublished peer destinations are enforced; uninitialized or already-uploaded allocations cannot be read/rewritten.

Caller wait cancellation/disposal does not free submitted resources. Pending operations retain source/destination allocations, staging, reservations, native context/library/stream/event or command buffer. Device loss invalidates epochs; uncertain native allocation/submit/read/teardown retains custody and stops growth, exposing a controlled-restart disposition. A driver-confirmed no-allocation OOM/nil rejection releases admission and permits future use. Source/operation/device lock inversions were corrected and covered by a barrier test. Disabled blocks new work even through previously acquired holds while existing consumers drain.

Large-BAR reports, CPU mapping, coherency, peer support, API version and per-workload qualification are separate. Classic CUDA/HIP allocations report CPU mapping Unsupported with DMA alternative. Explicit map/read/unmap leases retain epoch/allocation/synchronization and bound consumers; no native mapping API or raw PCI access is invented. Auto/Required selection consumes common release/runtime/workload qualification and admission. It does not promote discovery into qualification or activate product serving.

## Mandatory acceptance status

Every criterion below remains unaccepted. A passing ordinary assertion is a partial source contribution; hardware, frozen policy and actual consumer assertions are mandatory where specified.

| Criterion | Current contribution | Remaining acceptance |
| --- | --- | --- |
| P17-AC01 | Distinct discovery results, Disabled no loading, common Auto mode consumption | NotVerified: qualified omitted-config activation in actual governor/hardware; Required integration |
| P17-AC02 | Real CUDA/HIP/Metal allocation/copy source, pinned ABI dispatch tests | NotVerified: frozen complete target/API matrix and actual adapter runs; other promised rows unresolved |
| P17-AC03 | Explicit absolute loader/version profiles, no Disabled initialization | NotVerified: owner-approved shipped matrix/provenance and native runs |
| P17-AC04 | Common ledger, single host/subset charge, atomic staging/slot and both peer-domain admission | Blocked: frozen native physical-capacity bound/conversion and independent actual driver charge reconstruction |
| P17-AC05 | Cancellation barrier preserves all operation custody until completion | NotVerified: actual hardware T43 |
| P17-AC06 | Epoch invalidation, stale-result rejection and uncertainty quarantine | NotVerified: actual reset/loss T44 |
| P17-AC07 | Finite metadata/operation/staging holds, stop new growth, restart disposition | Blocked: common readiness/restart/recovery owner integration and hardware failure evidence |
| P17-AC08 | No full-card readback or reconstruction authority added | Blocked: actual Critical-host, coalesced admitted residency fallback seam/T45 |
| P17-AC09 | Shared-domain UMA unit assertion, no independent headroom | NotVerified: actual integrated device T46 |
| P17-AC10 | Complete unit copy bytes, equal content identities, initialized exclusive destination | Blocked: current eligibility/location publication and protected last-good representation integration |
| P17-AC11 | Disable stops new work and drains confirmed owners | Blocked: common bounded fresh qualification/recovery; native disable evidence |
| P17-AC12 | Unit evidence clearly separate | NotVerified: all required hardware rows |
| P18-AC01 | Large BAR never grants a host pointer; mapping facts separate | NotVerified: actual BAR/off/on/nonmappable T47 |
| P18-AC02 | No raw PCI resource mapping or device-pointer host-view conversion; version-bound map seam | NotVerified: promised native map rows; classic-device mapping is explicitly Unsupported rather than a success stub |
| P18-AC03 | Allocation/epoch/synchronization holds and final-consumer unmap unit tests | NotVerified: actual driver map/unmap interleavings |
| P18-AC04 | No speed claim or unfrozen threshold invented | Blocked: frozen comparable size/access/concurrency/P99/setup/teardown benchmark matrix/T48 |
| P18-AC05 | Common-qualified Auto workload path helper and admitted peer entry point | Blocked: shipped workload rules, bounded native qualification and actual automatic consumer selection |
| P18-AC06 | Rejected/unverified workload falls back; Required fails, never forces a path | NotVerified: actual qualification/performance class and declared consumer alternative |
| P18-AC07 | Real directional CUDA/HIP peer APIs, both-end native custody, complete payload units | NotVerified: actual topology and authorized consumer end-to-end; no NIC/Kestrel/TLS claim |
| P18-AC08 | Loss/stale epochs cannot publish success; uncertain resources stay charged | NotVerified: actual hardware mapping/peer loss |
| P18-AC09 | Disabled preheld map/peer/new consumers blocked; existing reads/copies drain | NotVerified: actual mapping/peer disable and residency fallback integration |
| P18-AC10 | Unsupported API and missing verification kept separate | NotVerified: promised matrix rows cannot be closed without their environments |

See [precise integration requests](integration-request.md) and the [unposted PR body](pr-body.md). Original common-owner inventory semantic closure, governor/Auto activation, oracle/baseline and held ProjectXML/semantic-adapter/cohort-pointer scopes were not edited or replaced.

## Source contracts and rollback

API references: [CUDA12.6.3 Driver API](https://docs.nvidia.com/cuda/archive/12.6.3/cuda-driver-api/index.html), [ROCm HIP6.2.4 header](https://github.com/ROCm/HIP/blob/rocm-6.2.4/include/hip/hip_runtime_api.h), [Apple Metal macOS14/iOS17 ABI mapping commit](https://github.com/apple/metal-cpp/tree/807c2cf7d2df9d30117d1031049af75733f535a2). Header/source inspection and unit dispatch do not establish real hardware qualification.

Safe rollback stops new selection, drains confirmed operations and consumers, and preserves uncertain charged custody for the existing controlled-restart owner. It does not force Free, reset a global runtime, read back a whole card, change drivers/security settings or weaken content authority. Ordinary tests verify the source drain contracts; no runtime rollout/rollback was performed.
