# Frozen 46b source-hook evidence

These are unchanged historical TRX bytes compressed with gzip, copied from the
original isolated runs. No test was rerun to produce this handoff. The source
under test was `46b864f22d067bf62d039d3ad91def1df53db20a`; the commit publishing this
evidence is not a new runtime qualification or independent acceptance.

`backend-selector.txt` is the exact 48,961-byte selector file used by the 619-case
run. `commands.json` retains the expanded filter argument and environment;
`binary-binding.json` retains the actual runtime SourceCommit and four DLL hashes.
`rosters-and-bindings.json` lists every display identity/outcome for the original
433,480,610 rosters and current619, plus compressed and uncompressed raw hashes.
The raw gzip files retain test definitions, execution identities, messages and
complete failures for independent re-reading. A reviewer can use Python's
`gzip.decompress` and `xml.etree.ElementTree` without running the suite again.

Historical current619 is615 PASS /4 FAIL. All original433/480/610 names are present;
all original433 and480 cases pass in current619, and the previously passing608
cases from610 remain passed. The four full-owner export failures remain real.

Correction to earlier informal reporting: **focused5 means3 PG +2 unit, not5 PG**.
The exact focused filter was:

```text
FullyQualifiedName~OriginalReceiptRecipeComponent|FullyQualifiedName~OriginalControlTable_PreservesNativeNotNull|FullyQualifiedName~OriginalNumericAndDeferredConstraintRecipes|FullyQualifiedName~RuntimeRollupCatalog_MatchesPostCodeFirstMigrationDdl
```

The three PG cases are the two `OriginalReceiptRecipeComponent` theory rows and
`OriginalControlTable_PreservesNativeNotNullAndRefusesItsRemoval`, all in
`FsusBlog.Server.Tests.Integration.SourceReceiptSchemaCoveragePostgresTests`.
The two unit cases are
`FsusBlog.Server.Tests.CurrentSchemaOwnedProjectionExporterTests.OriginalNumericAndDeferredConstraintRecipes_KeepTheirExistingFacts`
and
`FsusBlog.Server.Tests.CurrentSchemaRuntimeRollupTablesTests.RuntimeRollupCatalog_MatchesPostCodeFirstMigrationDdl`.
The complete receipt class in current619 is3 PASS /4 FAIL; focused5 never replaced
those four positive full-owner failures. Prior records are retained unchanged.

Original supplier23 unit+33 PG and the separate Migration162 includingnative22
must retain their own scope. This handoff supplies previously missing evidence to
independent review; it does not declare that review gap closed.
