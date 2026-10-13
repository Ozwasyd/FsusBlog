# Original property value native snapshot batch source

This increment is based on the preserved original owner a27a5c1922d681d9796a05acdd7f424362f26869.
Typed property values originated in953b5947df3e7218120c378493b3cdb16df63773. Latest
fetched master29051db2a80db7770dfe78a1db6e4c6998337324 does not contain that value
participant/authority/shared contract. The inherited a27-to-master622-file delta
is an unmerged prerequisite, not new implementation or new acceptance in this
increment. No inherited generated outputs, registry or qualification identity is
updated. Review the incremental a27..candidate range separately; whole-master
integration/metadata qualification cannot be inferred from this source result.

## Genuine existing producers

IArticlePropertyValueAuthority.ReadAsync is implemented explicitly by
ArticleService.ArticlePropertyValues.cs. It calls RequirePropertyTransactionEntry
(rejecting an ambient/native/Vault group transaction), then ExecuteForegroundWriteAsync
and UseTranAsync for one article. Calling it64 times would produce64 independent
transactions, not a shared Query snapshot. The new internal
ReadPropertyValuesInNativeSnapshotAsync never calls that entry or begins/commits/
rolls back/disposes a transaction or opens/closes a connection.

ArticlePropertyValuePersistence.ReadCurrentAsync reads the original head and
ReadSnapshotAsync reconstructs the original immutable factset entries/options/
references. It validates DefinitionDigest/ValueDigest, factset/snapshot digests,
actual article/publication coordinates and real signed audit. SaveMutationAsync
creates actual factset_id/property_revision; CarryForwardAsync preserves immutable
facts under actual new article revisions. These IDs/revisions/digests are real
value facts, not a global Query source-generation producer or document epoch.

ArticlePropertyDefinitionStore.GetManyAsync and
PostgresArticlePropertyDefinitionPersistence.GetManyAsync supply the existing
complete typed definitions. They do not own a read transaction. The added internal
binding methods verify their actual original PostgreSQL participant, not a fake
memory/provider callback. Value persistence adds an equally explicit native read
binding around its existing reader; no value decoder or second store is created.

## Actual scope and preservation

All three original participants must be in the caller's exact NpgsqlTransaction,
on the same open native connection, with RepeatableRead or Serializable isolation.
PostgreSQL transaction isolation/read-only and pg_current_snapshot are read from
that actual connection and checked again at the end. Snapshot text is bounded64KiB.
ReadCommitted/Unspecified/.NET Snapshot and missing/different/disposed transactions
reject; no isolation is silently changed. Returned MVCC text is data only.

The original actor/context/definition-owner permission helper,
LockCanvasLinkArticlesAsync and owner definition lock are reused. Their SHARE/
UPDATE locks require a readwrite snapshot; a readonly native Query transaction
rejects rather than weakening original authority. Principal permissions and actual
article lifecycle/revision facts are retained as data. Existing access rejects
archived/deleted articles and nonowner access; it cannot grant Restore or a broader
Query lifecycle policy. The original helper checks HTTP admin/session identity and
active principal permissions but is not a fresh session-revocation/epoch producer.
Live session admission still belongs to the original session/source reservation
owner. No permission digest or grant is manufactured here.

At most64 unique positive article IDs are captured without truncation, preserving
caller order. Metadata is read without loading full article bodies. A SQL count/
byte preflight admits at most4096 stored value entries and one bounded owner
schema/children set, under the existing32MiB verification resource limit, before
payload/definition materialization. Original per-factset and audit budgets and
validators remain active. Current definitions are read once using the union of
historical referenced definition IDs. Original reconciliation is invoked for every
article; null current values stay null/property revision0, missing required/default
facts stay reconciliation work, changed/inactive/unavailable definitions remain
reported, and nonempty article references remain ReferenceAuthorityUnavailable.
No DefinitionDigest/ValueDigest/default provenance or definition is rewritten.

Original public IArticlePropertyValueAuthority and ReadAsync behavior stay
unchanged. This internal source entry is not registered, routed, transported or
made available. It does not import a product assembly during verification.
Caller owns transaction lifetime and serializes use of the original SqlSugar/native
scope; unsupported concurrent/reentrant scope mutation is not qualified by these
before/after checks. Real native concurrency/isolation/revocation/cleanup/cancellation
and definition/value update consistency remain UNRUN.

## Exact missing Query producer input

No backend Query source-generation/reservation producer was found in master or the
preserved a27 source. Factset ID/property revision, database MVCC text, definition
schema revision and article revision cannot replace it. The original Query owner
must provide its real same-native-scope reservation identity and bind this exact
transaction/connection/MVCC observation to its admitted actor/admin/session and
actual definition-owner/site mapping. A readonly reservation needs an original
permission/article read contract that does not require current SHARE/UPDATE locks;
no substitute projection or private grant is added here.

The original parser/document owner must separately supply actual document/parser
epoch, source materialization and supported range/field producer bindings for
DefinitionDigest/ValueDigest. This batch supplies authenticated persisted fields,
not fsusblog.field.property assembly, fulltext membership, parsed source generation,
range or nonempty reference admission. Those mappings must be checked by the real
Query/parser owners before any activation; no fake source-generation receipt is
returned. The unmerged953/a27 typed-value prerequisite also must be supplied and
accepted by exact identity before master integration.

ArticlePropertyNativeBatchReadTests adds ordinary isolation/order/duplicate/budget
source controls; UNRUN and uncompiled. No DI/default availability, schema/catalog/
generator/fixture/receipt refresh, database connection/application, testhost/tests/
discovery/import, runtime or frozen qualification workload runs here. Static source
compilation is not Query/product/runtime acceptance. #3735/#3736/#3738 remain WIP;
original bulk preflight revision-reference producer remains queued independently.
