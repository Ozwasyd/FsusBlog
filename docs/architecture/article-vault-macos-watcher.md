# Article Vault macOS watcher boundary

The sole macOS observation assembly is `FsusBlog.ArticleVault.MacOS`. Its source,
symbols, native exports, test categories and commands are fixed in
`artifacts/article-vault/macos-watcher-package-inventory.json`. It is a platform
module of the existing Article Vault agent, without an agent executable, lease,
IPC server, normalizer, planner, materializer or package importer.

## Root and native admission

`MacVaultWatcherSession.Open` selects exactly one root, a sealed root manifest,
an agent identity and bounded options. Unsupported platforms fail with
`mac_vault_platform_required`. The native boundary requires local APFS, queries
the actual volume case capability, binds its FSEvents volume UUID and opens root
ancestors with `O_NOFOLLOW`. The admitted root descriptor and its current path,
device, mount and diagnostic file ID are rechecked at use.

The private `MacVaultRootPathScope` consumes the canonical Shared structural
validator. That validator does not grant native access. Descriptor-relative
Darwin admission independently rejects links, traversal, moved-out descriptors,
mount changes, missing ancestors and unreadable entries. Bounded sibling-name
checks reject case/Unicode aliases and control-tree aliases. The fixed control
manifest must remain digest-bound to the supplied site/Vault/device manifest;
control entries require the current user, safe write permissions and no regular
file hard links. This observer does not establish the exclusive agent lease.
That authority belongs to #2113 and remains required for the full agent.

Registered source projections and control paths retain their classifications.
Unknown editor temp, backup or lock files produce blocked, auditable facts. They
are not silently ignored or deleted. Missing leaves can be observed only through
an admitted existing parent. No absolute native event path enters the fact.

## Raw FSEvents and rescan boundary

The native shim uses CoreServices FSEvents with `WatchRoot`, `FileEvents` and
`NoDefer` on one serial libdispatch queue. It preserves event IDs, raw flags and
observed relative spellings. Its facts bind the site/Vault/device/agent/root,
manifest, APFS semantics and fresh watch instance, plus a local monotonic
sequence and observation clock metadata. A fact digest addresses this record;
it is not a source-body digest.

FSEvents does not provide a reliable paired rename, operation timestamp,
truncate length or final-body snapshot. Rename flags therefore retain only the
observed path, with null old/new slots. Unambiguous remove flags occupy the old
slot; other non-rename observations occupy the new slot. Combined native flags
remain combined. The normalizer and snapshot owner must derive any later
operation from their own verified observations. No mtime selects a winner.

Apple documents per-host event IDs across volumes and dropped-event recovery in
the [FSEvents programming guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html).
Consecutive IDs cannot be required for a root-filtered stream. Native drop/scan,
wrap, root-change, mount and unmount flags remain explicit rescan failures;
duplicate or decreasing IDs remain auditable and fail closed.

Each restart emits a rescan requirement. The pending queue is bounded, and one
reserved overflow slot preserves loss after earlier audit records without
clearing them. Native callbacks have a separate batch bound. No caller-provided
digest can acknowledge a rescan. Until #2112 provides its actual completion API
bound to the watch instance, event cut, outstanding queue loss and verified root,
the watermark and clean/sync admission remain invalid. This is a deliberate WIP
integration boundary, not completed normalization or runtime qualification.

`MacVaultObservationAdapter` projects validated native facts into the canonical
`VaultRawObservation` contract from capability
`e1b4ffba4781bf6729e38b240df8c7647f19768e`. It verifies the independently held
watch identity and comparison policy, retains native fact digests, and preserves
the canonical input bound. It does not invoke normalization. Unpaired rename
and combined operations map to unknown/rescan rather than invented move pairs.
That capability's structural rescan tracker stops at
`AwaitingNativeVerification`; it cannot release this observer's invalid native
watermark or substitute for actual native snapshots.

## Reads, teardown and verification

The only native content read is the bounded, fixed `.fsus/vault.json` control
manifest. Markdown is never opened for content reading, normalized or written.
No raw fact invokes a sync or server writer. Native exceptions produce stable
reason codes without body, token or absolute path diagnostics. Shutdown stops
and invalidates the stream, drains callbacks, releases the stream and queue,
closes descriptors and frees callback contexts. It never alters user files.

The project builds its Darwin dylib through the real Xcode compiler resolved by
`xcrun` on macOS. The build helper emits a compile database in the native output
directory only after that compiler succeeds. The integration registers the exact
native output directories and lockfile paths in the existing style/document
registries. Linux can compile the managed declarations and
execute contract checks; it cannot compile or qualify this native boundary.

```bash
dotnet restore tests/article-vault/macos/FsusBlog.ArticleVault.MacOS.Tests.csproj --locked-mode
dotnet test tests/article-vault/macos/FsusBlog.ArticleVault.MacOS.Tests.csproj --no-restore --filter Category=MacArticleVaultRawFactContract
node tools/test/check-macos-vault-observer-source.mjs
node --test tests/tools/macos-vault-observer-source.test.mjs
```

The source checker and mutation cases protect observation-only reads/writes,
bounded overflow, native stream creation and teardown obligations. They do not
prove native behavior or resource release.

On a real APFS macOS checkout, run:

```bash
dotnet test tests/article-vault/macos/FsusBlog.ArticleVault.MacOS.Tests.csproj --no-restore --filter Category=MacArticleVaultWatcher
```

This category has no platform skip. It exercises real native create/edit/remove,
rename, temp replace, truncate/partial write, symlink, permissions, control
tamper, root move, restart, Unicode/case and delivery overflow. Missing macOS,
APFS, Xcode, a native event or the required resource causes a failure. Physical
unmount/nested-mount, deterministic daemon drop injection, and independently
measured resource-leak evidence remain additional native acceptance obligations.

Issue #2674 requires a real current-source full-agent qualification with the
actual #2110/#2112/#2113/#2114/#1909 implementations. No platform qualification
receipt has been emitted. Contract fixtures do not qualify those dependencies.
The original #3582 owner receives registry and integration changes separately;
this subchain does not edit shared matrix, coverage, lifecycle or project owners.
