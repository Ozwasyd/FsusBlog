# Native binding review: static evidence only

Exact sources are fixed in `source-bindings.json`. This review is not native
Windows NTFS or macOS APFS acceptance. Host is Linux; `xcrun`/a Darwin SDK are
unavailable. Darwin C has not been compiled. No substitute native implementation
was loaded, no handles were fabricated and no host receipt was emitted.

| Boundary inspected | Observed source | Evidence limit |
| --- | --- | --- |
| Windows record ABI | 12-byte DWORD header, UTF-16 byte length, DWORD aligned next offset; separate native actions 1–5 | Managed decoder ordering and truncated-tail behavior exercised against the actual compiled decoder |
| Windows overlapped API | Exact `ReadDirectoryChangesW`, `GetOverlappedResult`, `CancelIoEx`, `CreateEventW`, `ResetEvent` imports; DWORD/bool/pointer mappings | Static signatures; real I/O/cancel races and kernel overflow unrun |
| Windows buffer loss | Zero transferred bytes report enumeration-required; reserved managed loss marker and sequence gap | Actual managed queue controls pass; native kernel loss unrun |
| Quiet Windows root movement | Directory API watches contents; root checks occur at startup and on delivery | Admitted parent/ancestor watch capability is explicitly missing; no quiet-root detection claimed |
| macOS C/managed ABI | Six entrypoints match inventory; C callback `(void*, const char*, uint32_t, uint64_t, int)` matches Cdecl managed delegate | C compilation/link/dylib copy/loading remain unrun |
| macOS stream flags | WatchRoot, FileEvents, NoDefer; char** paths because UseCFTypes is absent | Static semantics; actual stream unrun |
| macOS gaps/root flags | MustScanSubDirs/UserDropped/KernelDropped/EventIdsWrapped, root change, mount/unmount produce pending rescan | Pure `RawReason` controls pass; real native flag delivery unrun |
| macOS event IDs | Per-host IDs are monotonic and need not be consecutive for a particular root | Actual managed reason method accepts numerical gaps; never treats them as native proof |
| macOS teardown | Managed dispose marks disposed under gate, closes outside gate; native Stop→Invalidate→serial dispatch drain→Release→close/free; callback GCHandle freed after native close | Static lifecycle order only; real callback interruption/finalizer/resource tests unrun |
| Observer content boundary | Windows has no body reader; macOS native read is fixed control manifest; normalization takes supplied observations | Managed harness performs no Vault or Markdown I/O; native root/admission still unqualified |

Bindings checked against primary references:

- [Microsoft ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)
- [Microsoft FILE_NOTIFY_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-file_notify_information)
- [Apple FSEvents programming guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html)

The managed failures are recorded separately in JSONL. No API signature defect
was established by this static inspection. Native compilation, startup, runtime
delivery, root/permission drift, cancellation and callback leaks remain WIP.
