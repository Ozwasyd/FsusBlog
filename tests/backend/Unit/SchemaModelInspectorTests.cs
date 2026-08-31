using System.ComponentModel.DataAnnotations.Schema;

using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Testing;

using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class SchemaModelInspectorTests
{
    [Fact]
    public void TestMaterializerCommand_RoutesOnlyExactFirstArgument()
    {
        Assert.True(CurrentSchemaTestMaterializationCommandLine.IsRequested(
            [CurrentSchemaTestMaterializationCommandLine.CommandName]));
        Assert.False(CurrentSchemaTestMaterializationCommandLine.IsRequested(
            ["serve", CurrentSchemaTestMaterializationCommandLine.CommandName]));
        Assert.False(CurrentSchemaTestMaterializationCommandLine.IsRequested(
            [$"{CurrentSchemaTestMaterializationCommandLine.CommandName}-suffix"]));

        Assert.Contains(
            "argument_duplicate",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializationCommandLine.Parse(
                [
                    CurrentSchemaTestMaterializationCommandLine.CommandName,
                    "--output",
                    "first.json",
                    "--output",
                    "second.json",
                    "--run-id",
                    "run",
                    "--source-commit",
                    new string('a', 40),
                    "--service-envelope",
                    "/tmp/envelope.json"
                ])).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void TestMaterializerServiceEnvelope_BindsRunPostgresPortAndExactAdmission()
    {
        string sandbox = Path.Combine(Path.GetTempPath(), $"fsusblog-current-schema-envelope-{Guid.NewGuid():N}");
        Directory.CreateDirectory(sandbox);
        string envelopeFile = Path.Combine(sandbox, "services.json");
        try
        {
            const string RunId = "issue-3105-run";
            CurrentSchemaTestDatabaseIdentity databaseIdentity = CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                "Host=127.0.0.1;Port=35415;Database=fsusblog_test;Username=test;Password=test;Search Path=public");
            string validEnvelope = ServiceEnvelopeJson(RunId, "35415");
            File.WriteAllText(envelopeFile, validEnvelope);

            CurrentSchemaTestServiceIdentity identity = CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                envelopeFile,
                RunId,
                databaseIdentity);
            Assert.Equal("container-postgres", identity.ContainerId);
            Assert.Equal(35415, identity.HostPort);
            Assert.Matches("^[a-f0-9]{64}$", identity.EnvelopeSha256);

            Assert.Contains(
                "service_envelope_invalid",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                        envelopeFile,
                        "wrong-run",
                        databaseIdentity)).Message,
                StringComparison.Ordinal);

            File.WriteAllText(envelopeFile, ServiceEnvelopeJson(RunId, "35416"));
            Assert.Contains(
                "port_mismatch",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                        envelopeFile,
                        RunId,
                        databaseIdentity)).Message,
                StringComparison.Ordinal);

            string tamperedEnvelope = ServiceEnvelopeJson(RunId, "35415");
            const string ExpectedPort = "\"hostPort\":\"35415\"";
            int actualPortOffset = tamperedEnvelope.LastIndexOf(ExpectedPort, StringComparison.Ordinal);
            Assert.True(actualPortOffset >= 0);
            tamperedEnvelope = string.Concat(
                tamperedEnvelope.AsSpan(0, actualPortOffset),
                "\"hostPort\":\"35416\"",
                tamperedEnvelope.AsSpan(actualPortOffset + ExpectedPort.Length));
            File.WriteAllText(envelopeFile, tamperedEnvelope);
            Assert.Contains(
                "service_envelope_drift",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                        envelopeFile,
                        RunId,
                        databaseIdentity)).Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }

    private static string ServiceEnvelopeJson(string runId, string hostPort)
    {
        string service = $$"""
            {
              "id":"postgres",
              "kind":"container",
              "containerId":"container-postgres",
              "imageReference":"postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageId":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "repositoryDigest":"postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "ports":[{"containerPort":"5432/tcp","hostIp":"127.0.0.1","hostPort":"{{hostPort}}"}]
            }
            """;
        return $$"""
            {
              "schema":"fsusblog.test-execution-envelope-services.v1",
              "qualificationEligible":true,
              "producerId":"acceptance-runtime",
              "runId":"{{runId}}",
              "requiredServices":["postgres"],
              "planned":{"runtime":null,"services":[{{service}}]},
              "actual":{"runtime":null,"services":[{{service}}]},
              "admission":"planned-actual-exact",
              "correctnessImagePull":"denied",
              "hostFallback":"denied"
            }
            """;
    }

    [Fact]
    public void TestMaterializerBoundary_RequiresTestOptInLoopbackPublicSearchPathAndRunRoot()
    {
        var environment = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Test",
            [CurrentSchemaTestMaterializer.OptInEnvironmentVariable] = "1",
            [CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable] = Path.GetTempPath()
        };
        CurrentSchemaTestMaterializer.ValidateTestBoundary(environment);
        CurrentSchemaTestDatabaseIdentity identity = CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
            "Host=127.0.0.1;Port=5432;Database=fsusblog_test;Username=test;Password=test;Search Path=public");
        Assert.Equal("127.0.0.1", identity.Host);
        Assert.Equal("public", identity.SearchPath);
        string expectedReceipt = Path.Combine(Path.GetTempPath(), "fsusblog-current-schema-test", "receipt.json");
        Assert.Equal(
            Path.GetFullPath(expectedReceipt),
            CurrentSchemaTestMaterializer.ResolveOutputPath(expectedReceipt, environment));

        var production = new Dictionary<string, string?>(environment, StringComparer.Ordinal)
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Production"
        };
        Assert.Contains(
            "test_environment_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateTestBoundary(production)).Message,
            StringComparison.Ordinal);
        var missingOptIn = new Dictionary<string, string?>(environment, StringComparer.Ordinal);
        missingOptIn.Remove(CurrentSchemaTestMaterializer.OptInEnvironmentVariable);
        Assert.Contains(
            "opt_in_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateTestBoundary(missingOptIn)).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "loopback_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                    "Host=localhost;Database=fsusblog_test;Username=test;Password=test;Search Path=public")).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "public_search_path_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                    "Host=127.0.0.1;Database=fsusblog_test;Username=test;Password=test;Search Path=test_schema,public")).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "outside_run_root",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ResolveOutputPath(
                    Path.Combine(Path.GetPathRoot(Path.GetTempPath())!, "outside.json"),
                    environment)).Message,
            StringComparison.Ordinal);

        var missingReceiptRoot = new Dictionary<string, string?>(environment, StringComparer.Ordinal);
        missingReceiptRoot.Remove(CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable);
        Assert.Contains(
            "receipt_root_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ResolveOutputPath(expectedReceipt, missingReceiptRoot)).Message,
            StringComparison.Ordinal);
        var relativeReceiptRoot = new Dictionary<string, string?>(environment, StringComparer.Ordinal)
        {
            [CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable] = "relative-root"
        };
        Assert.Contains(
            "receipt_root_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ResolveOutputPath(expectedReceipt, relativeReceiptRoot)).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "assembly_source_mismatch",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(new string('1', 40))).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void TestMaterializerOutput_RejectsChildSymlinkEscape()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string sandbox = Path.Combine(Path.GetTempPath(), $"fsusblog-current-schema-output-{Guid.NewGuid():N}");
        string receiptRoot = Path.Combine(sandbox, "receipts");
        string outside = Path.Combine(sandbox, "outside");
        Directory.CreateDirectory(receiptRoot);
        Directory.CreateDirectory(outside);
        Directory.CreateSymbolicLink(Path.Combine(receiptRoot, "escape"), outside);
        try
        {
            var environment = new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                [CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable] = receiptRoot
            };
            Assert.Contains(
                "outside_run_root",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ResolveOutputPath(
                        Path.Combine(receiptRoot, "escape", "receipt.json"),
                        environment)).Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }

    [Fact]
    public void StartupVerifierSemanticGuard_RejectsTableColumnTypeIndexAndConstraintDrift()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);

        static SchemaModelSnapshot Snapshot(CurrentSchemaCanonicalModel model)
            => CurrentSchemaCanonicalAuthority.ProjectProvider(model, SchemaProviderKind.PostgreSql);

        SchemaModelSnapshot missingTable = Snapshot(canonical);
        ((Dictionary<string, SchemaTableModel>)missingTable.Tables).Remove("synthetic_table");
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, missingTable),
            static error => error.StartsWith("missing table", StringComparison.Ordinal));

        SchemaModelSnapshot missingColumn = Snapshot(canonical);
        missingColumn.Tables["synthetic_table"].Columns.Remove("state");
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, missingColumn),
            static error => error.StartsWith("missing column", StringComparison.Ordinal));

        SchemaModelSnapshot wrongType = Snapshot(canonical);
        SchemaTableModel typeTable = wrongType.Tables["synthetic_table"];
        typeTable.Columns["state"] = typeTable.Columns["state"] with
        {
            DataType = "int32"
        };
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, wrongType),
            static error => error.StartsWith("type mismatch", StringComparison.Ordinal));

        SchemaModelSnapshot wrongIndex = Snapshot(canonical);
        ((Dictionary<string, SchemaIndexModel>)wrongIndex.Tables["synthetic_table"].IndexDefinitions)["ux_synthetic_name"] =
            new SchemaIndexModel("ux_synthetic_name", true, ["state"]);
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, wrongIndex),
            static error => error.StartsWith("index mismatch", StringComparison.Ordinal));

        SchemaModelSnapshot wrongConstraint = Snapshot(canonical);
        ((Dictionary<string, SchemaConstraintModel>)wrongConstraint.Tables["synthetic_table"].Constraints)["ck_synthetic_state"] =
            new SchemaConstraintModel("ck_synthetic_state", "check", ["state"], Expression: "state = ''");
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, wrongConstraint),
            static error => error.StartsWith("constraint mismatch", StringComparison.Ordinal));

        SchemaModelSnapshot extraIndex = Snapshot(canonical);
        SchemaTableModel indexTable = extraIndex.Tables["synthetic_table"];
        indexTable.Indexes.Add("ix_synthetic_extra");
        ((Dictionary<string, SchemaIndexModel>)indexTable.IndexDefinitions).Add(
            "ix_synthetic_extra",
            new SchemaIndexModel("ix_synthetic_extra", false, ["state"]));
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, extraIndex),
            static error => error.StartsWith("extra index", StringComparison.Ordinal));

        SchemaModelSnapshot extraConstraint = Snapshot(canonical);
        ((Dictionary<string, SchemaConstraintModel>)extraConstraint.Tables["synthetic_table"].Constraints).Add(
            "ck_synthetic_extra",
            new SchemaConstraintModel("ck_synthetic_extra", "check", ["state"], Expression: "state <> ''"));
        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, extraConstraint),
            static error => error.StartsWith("extra constraint", StringComparison.Ordinal));
    }

    [Fact]
    public void BuildExpectedModel_ReflectsManagedTablesAndColumns()
    {
        var inspector = new SchemaModelInspector();

        IReadOnlyList<Type> entityTypes = inspector.GetManagedEntityTypes();
        SchemaModelSnapshot snapshot = inspector.BuildExpectedModel(entityTypes);

        Assert.Contains("article", snapshot.Tables.Keys);
        Assert.Contains("article_body", snapshot.Tables.Keys);
        Assert.Contains("page_content", snapshot.Tables.Keys);
        Assert.Contains("sys_user_session", snapshot.Tables.Keys);
        Assert.Contains("msg_conversation", snapshot.Tables.Keys);
        Assert.Contains("sys_audit_log", snapshot.Tables.Keys);
        Assert.Contains("frontend_rum_metric", snapshot.Tables.Keys);
        Assert.Contains("comment_moderation_signal", snapshot.Tables.Keys);

        SchemaTableModel article = snapshot.Tables["article"];
        Assert.Contains("title", article.Columns.Keys);
        Assert.Contains("createtime", article.Columns.Keys);
        Assert.DoesNotContain("content", article.Columns.Keys);

        SchemaColumnModel categoryDescription = snapshot.Tables["category"].Columns["description"];
        Assert.True(categoryDescription.IsNullable);
        Assert.Equal(500, categoryDescription.MaxLength);
        Assert.Equal("string", categoryDescription.DataType);

        SchemaColumnModel tagDescription = snapshot.Tables["tag"].Columns["description"];
        Assert.True(tagDescription.IsNullable);
        Assert.Equal(500, tagDescription.MaxLength);
        Assert.Equal("string", tagDescription.DataType);

        SchemaTableModel userSession = snapshot.Tables["sys_user_session"];
        Assert.Contains("idleexpiresat", userSession.Columns.Keys);
        Assert.Contains("absoluteexpiresat", userSession.Columns.Keys);
        Assert.Contains("rememberme", userSession.Columns.Keys);

        SchemaTableModel conversationMessage = snapshot.Tables["msg_message"];
        Assert.DoesNotContain("attachmentsmeta", conversationMessage.Columns.Keys);
        Assert.Contains("isinternalnote", conversationMessage.Columns.Keys);

        SchemaTableModel participantState = snapshot.Tables["msg_participant_state"];
        Assert.DoesNotContain("muted", participantState.Columns.Keys);

        SchemaTableModel user = snapshot.Tables["sys_user"];
        Assert.Contains("passkey_user_handle", user.Columns.Keys);

        SchemaTableModel auditLog = snapshot.Tables["sys_audit_log"];
        Assert.Contains("source", auditLog.Columns.Keys);
        Assert.Contains("type", auditLog.Columns.Keys);
        Assert.Contains("occurred_at_utc", auditLog.Columns.Keys);
        Assert.Contains("action", auditLog.Columns.Keys);
        Assert.Contains("actor_id", auditLog.Columns.Keys);
        Assert.Contains("target_type", auditLog.Columns.Keys);
        Assert.Contains("outcome", auditLog.Columns.Keys);
        Assert.Contains("severity", auditLog.Columns.Keys);
        Assert.Contains("ip_hash", auditLog.Columns.Keys);
        Assert.Contains("context_json", auditLog.Columns.Keys);
        Assert.Contains("record_hash", auditLog.Columns.Keys);

        SchemaTableModel rumMetric = snapshot.Tables["frontend_rum_metric"];
        Assert.Contains("name", rumMetric.Columns.Keys);
        Assert.Contains("page_type", rumMetric.Columns.Keys);
        Assert.Contains("metrics_json", rumMetric.Columns.Keys);

        SchemaTableModel modelSignal = snapshot.Tables["comment_moderation_signal"];
        Assert.Contains("comment_id", modelSignal.Columns.Keys);
        Assert.Contains("provider", modelSignal.Columns.Keys);
        Assert.Contains("contract_version", modelSignal.Columns.Keys);
        Assert.Contains("label", modelSignal.Columns.Keys);
        Assert.Contains("confidence", modelSignal.Columns.Keys);
        Assert.Contains("status", modelSignal.Columns.Keys);

        Assert.Equal(CurrentSchemaCanonicalAuthority.ModelVersion, snapshot.Identity?.ModelVersion);
        Assert.Matches("^[a-f0-9]{64}$", snapshot.Identity?.SourceDigest);
        Assert.Matches("^[a-f0-9]{64}$", snapshot.Identity?.ContentDigest);
    }

    [Fact]
    public void Extract_ResolvesInheritanceAttributesDefaultsIgnoredMembersAndConstraints()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);
        SchemaTableModel table = canonical.SemanticSchema.Tables["synthetic_table"];

        Assert.Contains("inherited_id", table.Columns.Keys);
        Assert.Contains("defaultname", table.Columns.Keys);
        Assert.DoesNotContain("ignored", table.Columns.Keys);
        Assert.DoesNotContain("notmapped", table.Columns.Keys);
        Assert.Equal("ready", table.Columns["state"].DefaultValue);
        Assert.True(table.Columns["optional_count"].IsNullable);
        Assert.Equal("json", table.Columns["payload"].DataType);
        Assert.Equal("json", table.Columns["payload"].Conversion);
        Assert.Equal(["defaultname"], table.IndexDefinitions["ux_synthetic_name"].Columns);
        Assert.True(table.IndexDefinitions["ux_synthetic_name"].IsUnique);
        Assert.Equal("primary-key", table.Constraints["pk_synthetic_table"].Kind);
        Assert.Equal("check", table.Constraints["ck_synthetic_state"].Kind);
        Assert.Equal("foreign-key", table.Constraints["fk_synthetic_parent"].Kind);
    }

    [Fact]
    public void Extract_FailsClosedForDuplicateAndAmbiguousOwnersOrUnsupportedConverters()
    {
        InvalidOperationException duplicateTable = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity), typeof(DuplicateTableEntity)]));
        Assert.Contains("Duplicate current schema table owner", duplicateTable.Message, StringComparison.Ordinal);

        InvalidOperationException duplicateColumn = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaCanonicalAuthority.Extract([typeof(AmbiguousDerivedEntity)]));
        Assert.Contains("Duplicate current schema column owner", duplicateColumn.Message, StringComparison.Ordinal);

        InvalidOperationException converter = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaCanonicalAuthority.Extract([typeof(UnsupportedConverterEntity)]));
        Assert.Contains("Unsupported current schema converter", converter.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ProviderProjection_SeparatesSemanticSchemaFromPhysicalDialect()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);
        SchemaModelSnapshot postgresql = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql);
        SchemaModelSnapshot mysql = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.MySql);
        SchemaModelSnapshot sqlite = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.Sqlite);

        Assert.Equal("character varying(64)", postgresql.Tables["synthetic_table"].Columns["defaultname"].PhysicalType);
        Assert.Equal("varchar(64)", mysql.Tables["synthetic_table"].Columns["defaultname"].PhysicalType);
        Assert.Equal("TEXT", sqlite.Tables["synthetic_table"].Columns["defaultname"].PhysicalType);
        Assert.Equal("string", postgresql.Tables["synthetic_table"].Columns["defaultname"].DataType);
        Assert.Empty(SchemaModelComparer.Compare(canonical.SemanticSchema, postgresql));
        Assert.Empty(SchemaModelComparer.Compare(canonical.SemanticSchema, mysql));
        Assert.Empty(SchemaModelComparer.Compare(canonical.SemanticSchema, sqlite));
    }

    [Fact]
    public void CurrentSchemaMismatch_IsFailClosedAndWriteFree()
    {
        var mismatch = new CurrentSchemaMismatchException(
            expectedDigest: "abc",
            actualDigest: "def",
            mismatchRef: "fsusblog.current-schema.mismatch",
            errors: ["missing table article"]);

        Assert.Contains("schema_current_mismatch", mismatch.Message, StringComparison.Ordinal);
        Assert.Contains("expectedDigest=abc", mismatch.Message, StringComparison.Ordinal);
        Assert.Contains("actualDigest=def", mismatch.Message, StringComparison.Ordinal);
        Assert.Equal("fsusblog.current-schema.mismatch", mismatch.MismatchRef);
        Assert.Equal("abc", mismatch.ExpectedDigest);
        Assert.Equal("def", mismatch.ActualDigest);
    }

    [Fact]
    public void ProjectionAndIndependentVerifier_RejectOldIdentityAndTampering()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(canonical);
        projection.Schema.Tables["synthetic_table"].Columns["defaultname"] =
            projection.Schema.Tables["synthetic_table"].Columns["defaultname"] with
            {
                MaxLength = 65
            };

        InvalidOperationException tamper = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaCanonicalAuthority.Generate(new CurrentSchemaCanonicalModel(projection.Schema, projection.Identity)));
        Assert.Contains("content digest mismatch", tamper.Message, StringComparison.Ordinal);

        CurrentSchemaCanonicalModel changed = CurrentSchemaCanonicalAuthority.Extract([typeof(ChangedSyntheticEntity)]);
        Assert.NotEqual(canonical.Identity.ContentDigest, changed.Identity.ContentDigest);
        Assert.NotEqual(canonical.Identity.SourceDigest, changed.Identity.SourceDigest);

        CurrentSchemaIndependentVerifier.Verify(
            canonical,
            new RuntimeEntitySchemaAdapter(),
            new GeneratedCurrentSchemaProjectionAdapter(),
            new MigrationTargetSchemaAdapter(),
            [typeof(SyntheticEntity)]);

        CurrentSchemaIdentity staleSourceIdentity = canonical.Identity with
        {
            SourceDigest = new string('0', 64)
        };
        InvalidOperationException staleSource = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaIndependentVerifier.Verify(
                new CurrentSchemaCanonicalModel(canonical.SemanticSchema, staleSourceIdentity),
                new RuntimeEntitySchemaAdapter(),
                new GeneratedCurrentSchemaProjectionAdapter(),
                new MigrationTargetSchemaAdapter(),
                [typeof(SyntheticEntity)]));
        Assert.Contains("identity mismatch", staleSource.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceIdentity_CoversClassLevelIndexesAndConstraints()
    {
        CurrentSchemaCanonicalModel baseline = CurrentSchemaCanonicalAuthority.Extract([typeof(SourceDigestBaselineEntity)]);
        CurrentSchemaCanonicalModel indexChanged = CurrentSchemaCanonicalAuthority.Extract([typeof(SourceDigestIndexChangedEntity)]);
        CurrentSchemaCanonicalModel constraintChanged = CurrentSchemaCanonicalAuthority.Extract([typeof(SourceDigestConstraintChangedEntity)]);

        Assert.NotEqual(baseline.Identity.SourceDigest, indexChanged.Identity.SourceDigest);
        Assert.NotEqual(baseline.Identity.ContentDigest, indexChanged.Identity.ContentDigest);
        Assert.NotEqual(baseline.Identity.SourceDigest, constraintChanged.Identity.SourceDigest);
        Assert.NotEqual(baseline.Identity.ContentDigest, constraintChanged.Identity.ContentDigest);
    }

    [Fact]
    public void Comparer_EmitsExactOwnedDifferences()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);
        CurrentSchemaProjection actual = CurrentSchemaCanonicalAuthority.Generate(canonical);
        SchemaTableModel table = actual.Schema.Tables["synthetic_table"];
        table.Columns.Remove("state");
        table.Columns["defaultname"] = table.Columns["defaultname"] with
        {
            IsNullable = true
        };
        table.Columns.Add("extra", new SchemaColumnModel("extra", true, false, false, null, "string"));

        IReadOnlyList<string> differences = SchemaModelComparer.Compare(canonical.SemanticSchema, actual.Schema);

        Assert.Contains(differences, static difference => difference.StartsWith("missing column synthetic_table.state owner=", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("extra column synthetic_table.extra owner=", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("nullable mismatch synthetic_table.defaultname", StringComparison.Ordinal));
    }

    [Fact]
    public void Comparer_ReportsProviderColumnIndexAndConstraintSemanticDrift()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);
        SchemaModelSnapshot actual = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql);
        SchemaTableModel table = actual.Tables["synthetic_table"];
        table.Columns["state"] = table.Columns["state"] with
        {
            DataType = "int32",
            DefaultValue = "stale",
            Conversion = "json"
        };
        table.Columns.Remove("defaultname");
        table.Columns.Add("default_name", new SchemaColumnModel("default_name", false, false, false, 64, "string"));
        table.Columns.Add("ignored", new SchemaColumnModel("ignored", true, false, false, null, "string"));

        var indexes = (Dictionary<string, SchemaIndexModel>)table.IndexDefinitions;
        indexes["ux_synthetic_name"] = indexes["ux_synthetic_name"] with
        {
            Columns = ["state"]
        };
        var constraints = (Dictionary<string, SchemaConstraintModel>)table.Constraints;
        constraints.Remove("pk_synthetic_table");
        constraints.Remove("fk_synthetic_parent");
        constraints["ck_synthetic_state"] = constraints["ck_synthetic_state"] with
        {
            Expression = "state = ''"
        };

        IReadOnlyList<string> differences = SchemaModelComparer.Compare(canonical.SemanticSchema, actual);

        Assert.Contains(differences, static difference => difference.StartsWith("type mismatch synthetic_table.state", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("default mismatch synthetic_table.state", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("conversion mismatch synthetic_table.state", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("missing column synthetic_table.defaultname", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("extra column synthetic_table.default_name", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("extra column synthetic_table.ignored", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("index mismatch synthetic_table.ux_synthetic_name", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("missing constraint synthetic_table.pk_synthetic_table", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("missing constraint synthetic_table.fk_synthetic_parent", StringComparison.Ordinal));
        Assert.Contains(differences, static difference => difference.StartsWith("constraint mismatch synthetic_table.ck_synthetic_state", StringComparison.Ordinal));
    }

    [Fact]
    public void ReadinessComparison_UsesSealedIdentityAndEntersSampling()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Extract([typeof(SyntheticEntity)]);
        CurrentSchemaReadinessBenchmarkReceipt receipt = CurrentSchemaReadinessComparison.Measure(
            canonical,
            static model => new GeneratedCurrentSchemaProjectionAdapter().Observe(model).Schema,
            static model => new MigrationTargetSchemaAdapter().Observe(model),
            warmupCount: 2,
            sampleCount: 3);

        Assert.Equal(2, receipt.WarmupCount);
        Assert.Equal(3, receipt.SampleNanoseconds.Count);
        Assert.All(receipt.SampleNanoseconds, static sample => Assert.True(sample >= 0));
        Assert.Equal(receipt.BaseContentDigest, receipt.CandidateContentDigest);

        CurrentSchemaIdentity staleIdentity = canonical.Identity with
        {
            SourceDigest = new string('0', 64)
        };
        InvalidOperationException mismatch = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaReadinessComparison.Measure(
                canonical,
                static model => CurrentSchemaCanonicalAuthority.Generate(model).Schema,
                model => new SchemaModelSnapshot(model.SemanticSchema.Tables, staleIdentity),
                warmupCount: 1,
                sampleCount: 1));
        Assert.Contains("same current schema identity", mismatch.Message, StringComparison.Ordinal);
    }

    public abstract class SyntheticBase
    {
        [SugarColumn(ColumnName = "inherited_id", IsPrimaryKey = true)]
        public long Id
        {
            get; set;
        }
    }

    [SugarTable("synthetic_table")]
    [SugarIndex("ux_synthetic_name", nameof(DefaultName), OrderByType.Asc, true)]
    [CurrentSchemaConstraint("ck_synthetic_state", "check", nameof(State), Expression = "state <> ''")]
    [CurrentSchemaConstraint(
        "fk_synthetic_parent",
        "foreign-key",
        nameof(ParentId),
        ReferencedTable = "parent_table",
        ReferencedColumns = ["id"])]
    public sealed class SyntheticEntity : SyntheticBase
    {
        [SugarColumn(Length = 64)]
        public string DefaultName { get; set; } = string.Empty;

        [SugarColumn(ColumnName = "state", Length = 24, DefaultValue = "ready")]
        public string State { get; set; } = string.Empty;

        [SugarColumn(ColumnName = "optional_count", IsNullable = true)]
        public int? OptionalCount
        {
            get; set;
        }

        [SugarColumn(ColumnName = "parent_id")]
        public long ParentId
        {
            get; set;
        }

        [SugarColumn(ColumnName = "payload", IsJson = true)]
        public Dictionary<string, string> Payload { get; set; } = [];

        [SugarColumn(IsIgnore = true)]
        public string Ignored { get; set; } = string.Empty;

        [NotMapped]
        public string NotMapped { get; set; } = string.Empty;
    }

    [SugarTable("synthetic_table")]
    public sealed class DuplicateTableEntity
    {
        public long Id
        {
            get; set;
        }
    }

    public abstract class AmbiguousBaseEntity
    {
        [SugarColumn(ColumnName = "value")]
        public string BaseValue { get; set; } = string.Empty;
    }

    [SugarTable("ambiguous")]
    public sealed class AmbiguousDerivedEntity : AmbiguousBaseEntity
    {
        [SugarColumn(ColumnName = "value")]
        public string DerivedValue { get; set; } = string.Empty;
    }

    [SugarTable("unsupported_converter")]
    public sealed class UnsupportedConverterEntity
    {
        [SugarColumn(SqlParameterDbType = typeof(UnsupportedConverterEntity))]
        public string Value { get; set; } = string.Empty;
    }

    [SugarTable("changed_synthetic_table")]
    public sealed class ChangedSyntheticEntity
    {
        [SugarColumn(IsPrimaryKey = true)]
        public long Id
        {
            get; set;
        }

        [SugarColumn(Length = 65)]
        public string Name { get; set; } = string.Empty;
    }

    [SugarTable("source_digest")]
    [SugarIndex("ux_source_digest_state", nameof(State), OrderByType.Asc, true)]
    [CurrentSchemaConstraint("ck_source_digest_state", "check", nameof(State), Expression = "state <> ''")]
    public sealed class SourceDigestBaselineEntity
    {
        [SugarColumn(IsPrimaryKey = true)]
        public long Id
        {
            get; set;
        }

        public string State { get; set; } = string.Empty;
    }

    [SugarTable("source_digest")]
    [SugarIndex("ux_source_digest_state", nameof(State), OrderByType.Asc, false)]
    [CurrentSchemaConstraint("ck_source_digest_state", "check", nameof(State), Expression = "state <> ''")]
    public sealed class SourceDigestIndexChangedEntity
    {
        [SugarColumn(IsPrimaryKey = true)]
        public long Id
        {
            get; set;
        }

        public string State { get; set; } = string.Empty;
    }

    [SugarTable("source_digest")]
    [SugarIndex("ux_source_digest_state", nameof(State), OrderByType.Asc, true)]
    [CurrentSchemaConstraint("ck_source_digest_state", "check", nameof(State), Expression = "state = ''")]
    public sealed class SourceDigestConstraintChangedEntity
    {
        [SugarColumn(IsPrimaryKey = true)]
        public long Id
        {
            get; set;
        }

        public string State { get; set; } = string.Empty;
    }
}
