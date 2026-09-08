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
case. These focused tests qualify issue #2672 only; they are not the full Linux
agent qualification owned by issue #2675.
