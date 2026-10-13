# Article Vault Linux watcher boundary

The Linux watcher is the read-only native observation boundary for one verified
Article Vault root. Its package inventory is
`artifacts/article-vault/linux-watcher-package-inventory.json`, and the sole
production assembly is `FsusBlog.ArticleVault.Linux`.

## Admission and identity

`LinuxVaultWatcherSession.Open` accepts an absolute root, a sealed
`ArticleVaultRootManifest`, one agent identity, and bounded resource options. It
validates the supplied manifest through `ArticleVaultManifestValidator`, reads
the bounded `.fsus/vault.json` control manifest, and requires the two sealed
bindings and content digests to match. The root must resolve to itself without a
symlink and must be on a supported local Linux filesystem.

The session binds every fact to the manifest site, Vault and device identities,
the agent identity, the canonical root and mount identities, the root-manifest
digest, and a fresh watch-instance identity. Path, inode and inotify cookie are
never article identities.

## Native observation contract

The package opens inotify with `IN_NONBLOCK | IN_CLOEXEC`, installs bounded
directory watches, and retains raw descriptor, mask, cookie and name semantics.
It does not pair move cookies into a normalized rename, read Markdown source,
stable-read files, materialize content, invoke the sync planner, or call a
server writer.

Every path-bearing record must resolve to a descriptor owned by the current
watch instance. An unknown descriptor cannot lend its name to the Vault root:
it produces a pathless blocked fact, invalidates the watermark, and requires a
rescan. Kernel queue overflow remains descriptor-independent and likewise
discards any path or cookie fields.

Each `LinuxVaultRawFact` has a monotonic per-session sequence, realtime and
monotonic timestamps, raw old or new root-relative path placement, path
disposition, failure and rescan state, and a canonical SHA-256 digest. Event
classes preserve create, modify, close-write, moved-from, moved-to, delete,
self-move, self-delete, unmount, invalidation and overflow observations.
Validation closes both enum domains and the event shape: moved-from carries
only the old path, moved-to and ordinary mutations carry the new path, cookies
remain move diagnostics, and blocked or rescan facts require a stable error
while the watermark is invalid.

## Path and failure safety

The watcher resolves the exact root and mount through Linux `realpath` and
`/proc/self/mountinfo`. Existing event paths must remain beneath the canonical
root, contain no symlink component, retain the admitted mount identity, and
retain readable filesystem permissions. Missing delete or move-from entries
remain auditable only when their existing parent still satisfies the same
boundary.

Name-less events for the watched root use the empty root-relative path and
revalidate the admitted canonical root, mount identity, filesystem, access
mode, and control manifest. A root `IN_ATTRIB` therefore cannot bypass the
same permission and mount checks applied to named descendants.

The `.fsus` tree is classified as control state rather than article source. A
case-colliding control directory, symlink, nested bind mount, root escape,
permission loss, dynamic watch failure, queue overflow, watch invalidation,
root move, unmount, or restart produces a blocked or `rescan-required` fact and
invalidates the watermark. The watcher never performs the rescan; a later owner
may acknowledge a verified rescan receipt to make the current raw watermark
valid again.

## Bounds and lifecycle

`LinuxVaultWatcherOptions` bounds facts returned per read and total watch
descriptors. Kernel overflow and a user-space delivery bound both remain
observable and fail closed. Disposal removes registered watches, closes the
inotify descriptor, and never changes user files.

Run the package-focused real ext4 tests with:

```bash
dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore --filter Category=LinuxArticleVaultWatcher
```

The tests use actual inotify records on the repository's ext4 filesystem. They
also use an isolated user and mount namespace for the bind-mount rejection
case. These focused tests qualify issue #2672 only.

## Platform qualification

Issue #2675 seals the full Linux filesystem-agent qualification in
`artifacts/article-vault/linux-agent-qualification.json`. The manifest binds
the kernel interface, ext4 mount semantics, agent and protocol identities, the
sealed command, and every case to its test method; it also declares which
still-open dependency layers (#2110, #2112, #2113, #2114, and the #1909 server
writer side) are simulated at contract level inside the test harness. Nothing
in the qualification modifies production code or substitutes for the
Windows/macOS qualifications.

```bash
dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore --filter Category=LinuxArticleVaultAgentQualification
```

Each run writes an append-only, privacy-safe `evidence.jsonl` and a sealed
`receipt.json` under `.tmp/article-vault-linux-qualification/`. The receipt is
independently verifiable with:

```bash
node tools/test/verify-linux-vault-agent-qualification.mjs --receipt .tmp/article-vault-linux-qualification/<run>/receipt.json
```

## Root-relative path inspection

The #2109 `LinuxVaultRootPathScope` is part of the same Linux package. Its private
constructor accepts only the root returned by the existing
`LinuxVaultRootVerifier.Verify`; callers cannot reconstruct it from a structural
digest or caller-verified native facts. `Open` snapshots the canonical manifest
and admits the explicitly chosen root through that verifier without allocating a
watcher. Subsequent `AnalyzeProjection` requests take only relative projections,
recheck the admitted root/control-manifest binding and use the existing native
relative-path verifier. No source body is read or written, and no watcher,
normalization, materialization, IPC or server writer is added.

The shared `ArticleVaultPathStructureValidator` produces bounded, deterministic
structural classification for manifest source/control projections. Unknown editor
temp/backup/lock files block instead of disappearing through generic ignore rules.
Path shape, case/Unicode/ancestor collisions, two portable IDs assigned to the
same path and a file used as an ancestor produce explicit blocked facts. Digests
bind scope, fixed registry, original spellings and observation inventory; the
independent verifier takes its expected request and inventory from consumer
context. It never constructs native authority. Every structural analysis retains
`RequiresNativeAdmission=true`, including one returned after native inspection:
future content access needs fresh verification at its own use boundary.

The scope now owns an initial native root descriptor and implements `IDisposable`.
`OpenSourceFile(relativePath)` opens only a registered source projection read-only;
`OpenOwnedParent(sourceRelativePath)` derives its parent without accepting an
arbitrary parent or control-tree path. `RevalidateForUse(issuedDescriptor)` accepts
only handles issued by that live scope, independently reopens their exact relative
paths and checks root/mount/device/inode identity. The scope closes its root and all
issued handles, supports repeated disposal and bounds live handles to 64.

Relative resolution uses `openat2` with beneath, no-symlink and no-mount-crossing
constraints. Missing kernel interfaces fail closed. Native metadata queries reject
casefold directories and unavailable directory semantics, including root, control
tree and each source parent. Only the fixed control manifest is read for binding;
stable source reads and source mutations remain with their respective owners. Revalidation is
an observation: a later external rename can still intervene before a writer uses
a parent. Each content owner must perform its own root-anchored resolve/use and
completion checks. These APIs do not grant stable-read, atomic-write, lease,
exclusive control-tree ownership or native qualification.

`OpenDirectoryForEnumeration(relativeDirectoryPath)` issues a read-only directory
descriptor under that same root for the existing rescan owner. `.` names the held
root; other inputs must be portable relative directory paths. Unknown source
directories can be opened, while `.fsus`, root escape, link/mount crossings and
unavailable filesystem semantics fail closed. The root owner does not enumerate
entries or infer portable identities. The rescan owner must enumerate the actual
descriptor, preserve unknown names as facts and revalidate before and after use.

`OpenOwnedParentMetadata(sourceRelativePath)` derives the registered source parent
and opens a read-only metadata descriptor that can service directory flush
syscalls. The existing `OpenOwnedParent` continues to return an `O_PATH` descriptor.
The native operation owner invokes the flush and accounts for its actual errors.

`OpenMutationBoundary(instruction, expectedOldMetadata)` binds the original
canonical instruction to the live root/agent, exact registered source projection,
plan/result/operation/journal references and original byte identities. Existing
sources must match actual descriptor identity, length and permission metadata;
bounded expected-old byte comparisons also check statx change/modify times and
revalidate the issued source and parent. A missing leaf is acceptable only for an
explicit expected-absent operation and a verified existing parent. Denial is never
treated as deletion. This comparison guard produces no stable snapshot receipt.

The returned process-owned boundary can create one private `O_EXCL` temporary
file in the source parent, with an instruction-bound name and random nonce. It
does not overwrite the source. Its metadata-parent callback lets the canonical
native owner use a real directory descriptor for flush. Repeated creation is
refused; closing the boundary closes handles and preserves named artifacts for
recovery. Failed post-creation guards can leave a temporary artifact; the operation
owner must retain that exact path and handle unknown outcome, rather than deleting
by a raced name. Unknown artifact discovery still blocks; no prefix-ignore rule
was added.

The canonical observation consumer now composes these real descriptors.
`LinuxVaultTemporarySourcePreparer.Prepare` checks desired original bytes, writes
the operation-owned temporary in bounded chunks, flushes its file and parent
directory, and reads the descriptor back with metadata and byte checks. It keeps
interrupted artifacts and reports preparation stages. A verified temporary is
not final-source verification, accepted complete metadata, conditional replacement
or a base receipt; its replacement and base capability flags remain false.

`LinuxVaultRescanReader.Scan` traverses actual root-issued directories twice,
decodes strict bounded `getdents64` records and checks directory metadata and tree
drift. The scan bounds directories, entries, depth, directory reads and total
observed source bytes. Unknown source names remain observations with admission
blocked; unreadable snapshots remain failures rather than deletions. Structural
completion still requires a native terminal receipt with the actual watch-event
cut and protected lease. Neither enumeration nor caller-supplied completion facts
grant synchronization admission.

`CanExecuteConditionalReplacement` and `CanCommitBase` remain false. Final source
create/replace/remove needs the canonical native owner's external-writer exclusion,
expected-old conditional namespace primitive, completed accepted metadata and
permission admission, flush/readback and journal/base receipt. A check followed by
unconditional rename is insufficient. No permissions are changed, no source is
replaced, and no denied protected-lease QA or platform qualification is inferred.

The original Linux project registers the dedicated owner filter in the existing
package inventory:

```bash
dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore --filter Category=LinuxArticleVaultRootPath
```

Windows NTFS and macOS APFS native admission remain unimplemented. Existing Linux
filesystem semantics and control-manifest checks do not prove exclusive agent
control-tree ownership, race-free future content access or full #2109/platform
qualification. Unsupported filesystem and realpath/mount/link/permission failures
remain native denials, never structural fallback success. Current acceptance must
be bound to the actual candidate and host; no native pass is asserted here.
