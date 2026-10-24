# Classification proof experiments

The helper compiles synthetic positive and adversarial C# examples using the
installed .NET 10 SDK's Roslyn assemblies. It never participates in the checker
and always returns qualification=false. Original checker and original test
identities, assertions, timeouts and outcomes are unchanged.

Run the independently invoked synthetic controls from the repository root with the .NET 10 SDK available:

```sh
node --test tests/tools/change-contract-classification-proof.test.mjs
```

The source comparison is optional and requires exact explicit Git revisions:

```sh
node tests/tools/change-contract-classification-proof.mjs \
    --repository /workspace/FsusBlog \
    --base e5f0d2d21b21635232b37dc6175f1f744129c836 \
    --head 39f955b633534836035cd5b5a85d13cdc414eff8 \
    --out /tmp/classification-proof.json
```

Git objects are read with replacement refs disabled, through the existing
regular-blob reader. C# bytes are materialized into an isolated temporary tree.
No candidate MSBuild files, source generators, tests or application assemblies
are executed. Only hardcoded synthetic fixtures execute. The separate manual
shared-source compilation emits assemblies in memory and inspects bytes.

Observed exact input:

- Three XML-comment source additions: 4421, 4662 and 1093 ordered tokens equal;
  all bytes outside complete XML comment lines are identical.
- Under this manual model, 118 tracked Shared source files plus one synthesized
  global-using tree emit the same PE and 10253-method projection on both sides.
- Benign XML documentation and a simple private-field rename preserve the
  synthetic returned value. The rename still changes field metadata.
- Adding an XML line changes an implicit CallerLineNumber result from 4 to 5.
- Editing only XML trivia changes a documentation-driven generator result 1→2.
- Renaming internal static SnapshotTime inside private nested ContractObserver
  changes CallerArgumentExpression text and makes an unchanged reflection
  lookup fail. nameof and raw-string documentation lookalikes also change results.

Limits and disposition:
The manual model uses trusted-platform references and synthesized global usings.
It does not reconstruct or prove the real project's complete MSBuild/import,
reference, conditional compilation, generator/analyzer, interceptor, language,
configuration or downstream documentation-consumer closure. Identical manual PE
bytes and observed fixture outcomes cannot qualify arbitrary source changes.
The active source-doc/private-naming classifications therefore remain FAIL.

A safe future generic implementation needs a separately reviewed trusted compiler
and project/reference/generator closure, exact Git input binding, complete syntax
and symbol proofs, both source and generated/runtime output equivalence, and
fail-closed handling of every unsupported construct. Running candidate MSBuild or
trusting candidate IL/digest receipts is not a substitute. This source handoff
does not establish that producer or grant owner promotion.

No file/test-path exemption, candidate SHA allowlist, relabeling, threshold/rule
change, application edit, consumer receipt edit or authority/index regeneration
is introduced. #4723 remains frozen at 36f4c1fc1106878b99c9ca45288379dc29f2befe.
Trusted-base policy replacement remains unconditional; promotion requires
separate owner authorization and independent exact-source qualification.
