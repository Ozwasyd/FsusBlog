# Accepted-master SDK inventory verification

Informational follow-up for issue #3620; qualification remains false. The entire
owned assignment is this one execution issue, with no tracking issue. It remains
blocked. This record supplements [the SDK follow-up](../20261008T064757Z-f416d662fd80/README.md)
and preserves its negative evidence rather than replacing it with accepted-source
or upstream receipts.

## Current source and prerequisite check

Fetch verified accepted master `a4fa942e95b6141e1f1dec42f7cddf1daf54144d`.
The actual tested branch candidate is
`fc65446fcfc156eaafc36ca5a0fdc8ac26b889e4`, whose SDK Compile source is
the previously consumed exact `2cf8f6d63841db81039f0eb7ec4720d6c0b800fa`
increment in local commit `460221414411dc31d069e64183f59cdb2170d1e1`.
The three complete source/test/manifest files and SDK documentation paragraph
match accepted master exactly. Compatible prior work and literal test identities
are retained; no duplicate cherry-pick or independent implementation was made.

The original `git merge-tree --write-tree origin/master HEAD` exits 0 with tree
`35ce6373c73045629fe18c7fc90d6df0674b92d8`. This is a virtual conflict check,
not a master merge or the final cross-chain conflict-resolution phase. The current
issue body and relevant comments were reread; the issue is OPEN, last updated
`2026-10-08T05:13:09Z`, with unchanged scope and no added direct prerequisite.

Official Node 24.16.0 and SDK 10.0.401/runtime 10.0.12 remain real installed
toolchains. The external task-owned diagnostic NuGet cache remains
`/workspace/chain3620-nuget`; the SDK source merge does not grant cache,
retained-build, nested-channel or native authority. Denied scopes and paused
GitHub content writes remain excluded.

## Original executable checks

Exact commands, exits and complete logs are in [observations](observations.json).
The current identity, writer and context owners pass 52/52 with zero skips,
including original healthy-proc negatives, real Linux child exit, persisted group
identity assertions and the owned first-write readiness regression. No cases or
negative controls were removed or renamed.

The original lifecycle/retention owners exit 1: 45 passed, one failed, zero skipped.
The original CLI still refuses the external diagnostic cache's actual
`Microsoft.NET.Test.Sdk.Program.cs` as outside the canonical repository boundary.
This refusal is retained. No copied Program.cs, manual repository cache relocation,
invented Production run ID or reconstructed owner channel is used.

The canonical inventory command uses its original producer, real project builds
and a task-scoped output path:

```sh
node tools/test-inventory/produce.mjs --configuration Debug \
  --out .tmp/chain3620-accepted-master/test-inventory.json
```

Its execution is diagnostic and does not establish original retained Production
or native scheduler acceptance. An accepted SDK source capability does not make
the complete inventory, retention or finalizer stage pass automatically.

The original producer exits 1 and writes no inventory artifact. It completed
the Backend stage and then actually failed the Migration build at
`OfflineMigrationExpandSafetyTests.cs:79–80` with CS0246 for `CreateTableStep`
and `AddColumnStep`. Migration reports 1554 warnings, two errors and 35.68 seconds.
The complete producer output is preserved; the producer itself emits only the
last twenty lines of its failed build and does not export successful Backend
stdout. This is not a claimed complete Backend build log or unit-test receipt.
The wrapper independently captures the actual exit as 1, without inferring it.

Only informational evidence files were written while this producer ran; no
affected source, project, lock or test was edited. This diagnostic is not promoted
to candidate qualification. The SDK compiler helper was identified as a child
of this task's build and is cleaned through official task-scoped SDK shutdown;
that cleanup is not the canonical native finalizer acceptance.
Shutdown exits 0. The exited compiler PID 149352 is observed as defunct under
PID 1 afterward; complete process reaping is not claimed or manufactured.

## Remaining gates

The original retained owner must supply its verified repository-contained attempt
restore/build and actual nested channel before the new SDK capability can accept
those retained Compile observations. Merely setting NUGET_PACKAGES is insufficient.
The original native lane's most recent actual source run still refuses cgroup
`/..`, as recorded separately; native cleanup and interrupted/repeated finalizer
flows remain unrun. This follow-up does not claim a new native lane execution.

Canonical Migration type fixes, the earlier composite commit-footer refusals and
protected generated/naming admission remain with their existing owners. Nothing
is waived or silently rewritten. The existing draft PR is #3844 on
`codex/chain-3620-linux-observation`; comments and PR content updates remain paused
under the global rate-limit instruction. No issue closure, PR merge, deployment
or package publishing occurs.

The precise compiler handoff needed from canonical #3654 is an exact compatible
fix for those two unresolved type references and a successful original complete
inventory-producer run. Its earlier Backend fixture handoff contained no such
Migration change; this follow-up does not implement that other owner's fix.
