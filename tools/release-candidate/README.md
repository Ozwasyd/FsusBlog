# Candidate input identities

`identity-contract.mjs` owns the closed candidate-input descriptor, SHA-256 seal,
independent verifier and field-level diff. Run IDs, ordinals, process IDs, ports,
logs and measurement timestamps belong to separate run receipts. Business epoch,
timezone and culture are semantic inputs. There is no age or TTL rule: changing
an input, schema, catalog or policy creates a different candidate identity.

`collect-source-worktree.mjs` calls the canonical
`snapshotRepositorySourceIdentity` API in `tools/test/repository-source-snapshot.mjs`.
It requires a physical Git root and an explicit source policy:

```json
{
    "schema": "fsusblog.repository-source-policy.v1",
    "untracked": "include",
    "ignoredInputs": []
}
```

Each consumed ignored file must be explicitly declared with `ownerId`, `path`,
`reason`, `consumedBy` and `required`. These declarations must come from the
consumer's authority. An empty list does not establish that all actual producers
have registered every ignored input. Arbitrary cache directories are not scanned.

```bash
node tools/release-candidate/collect-source-worktree.mjs --repo . --policy /explicit/source-policy.json
node --test tests/tools/release-candidate-identity.test.mjs tests/tools/release-candidate-source-worktree.test.mjs
```

The snapshot includes index objects/stages and actual tracked/untracked file
contents and executable modes, relative symlink targets, declared ignored inputs
and parent Git submodule pointers. Alias and submodule checkout contents need
their separate collector. The digest excludes physical roots and mtimes. File
reads check BigInt filesystem identity before and after reading; the collector
reobserves bytes and Git inventory before sealing. Unsafe hidden index flags,
shallow repositories, special files, missing objects and escaping paths fail.
Collection never installs, builds, checks out, cleans or stashes inputs.
Git object lookups reject partial/promisor stores and disable lazy fetching and
configured fsmonitor hooks for each invocation without editing Git configuration.

The shared scheduler and Reliability consumers have not adopted this API in this
increment. Their owners must replace their current source snapshot boundary,
call it before seal, before each major producer and after the run, and compare
`diffRepositorySourceSnapshots` output. Any changed input cancels qualification
and reports changed paths. A passing module test does not establish this uptake
or actual runtime acceptance. The repository-level ignored-input declaration and
cross-consumer governance also remain with their canonical owners.

Downstream candidate aggregation requires verified alias/policy/build/fixture/
execution identities. Missing receipts cannot be filled with SHA-only or manual
defaults, and this source contract does not create a qualified candidate.
