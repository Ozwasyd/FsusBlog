# Windows Article Vault raw watcher

The canonical root/path scope now exposes `WindowsVaultRootPathScope.Open` and
relative `AnalyzeProjection`. Private construction admits a real local NTFS root,
pins its ancestry, verifies volume identity and directory case mode, rejects
reparse/hardlink aliases and rechecks actual control-manifest bytes. Serialized
structural results grant no native capability. Same-assembly observer integration
can consume `DuplicateRootHandleForWatcher`, `CreateWatchIdentity`, `RevalidateRoot`
and `RevalidatePath`; duplicated handles have independent ownership. The watcher
factory must still be wired by its original owner. Full ACL/control-tree exclusive
ownership, rescan admission and real Windows qualification remain separate gates.

This Windows platform module belongs to #2670. It observes an owned overlapped
NTFS directory handle through `ReadDirectoryChangesW`, retains native action and
UTF-16 relative spelling, and emits bounded content-addressed facts. Rename old
and new records remain separate. Replace/truncate/temp-save sequences are raw
add/remove/change/rename observations; the watcher does not infer completed saves.
`FILE_NOTIFY_INFORMATION` contains neither a rename cookie, file ID nor body
digest. Those nullable slots remain empty rather than inventing correlations.

Production construction is deliberately assembly-private. Current #2109 source
provides structural rules and Linux admission only. The integration owner must
supply the exact Windows root capability, admitted overlapped handle and native
root/path/control-tree revalidation API before adding a production factory. Quiet
root moves also need admitted parent/ancestor watch coordinates: the native API
does not report changes to the watched directory itself. This
module contains no alternate root verifier, arbitrary absolute-path API or body
reader. The private seam and test assembly friendship are transport test access,
not native root qualification or permission to publish an agent package.

Every new session starts with a rescan-required restart fact. Native overflow,
malformed records, queue loss and failed admission emit a failure fact. One
managed queue slot is reserved for observable overflow; later sequences expose
loss. No raw-fact operation can mark a watermark clean. #2112 owns rescan proof
and admission. Cancellation drains outstanding I/O before freeing native buffers
and closing the directory/event handles. Observation does not mutate user files.

The inventory fixes commands and owners:
`artifacts/article-vault/windows-watcher-package-inventory.json`.

```bash
dotnet restore tests/article-vault/windows/FsusBlog.ArticleVault.Windows.Tests.csproj --locked-mode
dotnet test tests/article-vault/windows/FsusBlog.ArticleVault.Windows.Tests.csproj --no-restore --filter Category=WindowsArticleVaultWatcherContract
dotnet test tests/article-vault/windows/FsusBlog.ArticleVault.Windows.Tests.csproj --no-restore --filter Category=WindowsArticleVaultWatcher
```

The last command requires real Windows and an NTFS temporary directory. Required
native cases fail on other hosts; they do not skip or use another filesystem.
Transport tests open real handles in test-only code; their minimal callbacks do
not qualify #2109 path safety. Contract controls run independently and cannot
replace native execution. Full #2673 qualification also needs stable read/write,
normalization/rescan, lease/IPC, lifecycle and protocol capability receipts. There
is no full-agent command or platform receipt while these APIs and real Windows
NTFS evidence are absent. All original qualification and privacy criteria remain
open. No mock full-agent harness or success log is supplied.
