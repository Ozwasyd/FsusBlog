using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Schema;
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

        string[] required =
        [
            "--run-id", "run",
            "--source-commit", new string('a', 40),
            "--service-envelope", "/tmp/envelope.json",
            "--service-catalog", "/tmp/catalog.json"
        ];
        foreach (string option in new[] { "--run-id", "--source-commit", "--service-envelope", "--service-catalog" })
        {
            int valueIndex = Array.IndexOf(required, option) + 1;
            Assert.Contains(
                "argument_duplicate",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializationCommandLine.Parse(
                    [
                        CurrentSchemaTestMaterializationCommandLine.CommandName,
                        .. required,
                        option,
                        required[valueIndex]
                    ])).Message,
                StringComparison.Ordinal);
        }
    }

    [Fact]
    public void TestMaterializerServiceEnvelope_BindsRunPostgresPortAndExactAdmission()
    {
        string sandbox = Path.Combine(Path.GetTempPath(), $"fsusblog-current-schema-envelope-{Guid.NewGuid():N}");
        Directory.CreateDirectory(sandbox);
        string envelopeFile = Path.Combine(sandbox, "services.json");
        string catalogFile = RepositoryFile("config", "testing", "test-execution-service-catalog.json");
        try
        {
            const string RunId = "issue-3105-run";
            CurrentSchemaTestDatabaseIdentity databaseIdentity = CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                "Host=127.0.0.1;Port=35415;Database=fsusblog;Username=fsusblog;Password=test;Search Path=public");
            string validEnvelope = ServiceEnvelopeJson(catalogFile, RunId, "35415");
            File.WriteAllText(envelopeFile, validEnvelope);

            CurrentSchemaTestServiceIdentity identity = CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                envelopeFile,
                catalogFile,
                RunId,
                databaseIdentity);
            Assert.Equal(new string('a', 64), identity.ContainerId);
            Assert.Equal(35415, identity.HostPort);
            Assert.Matches("^[a-f0-9]{64}$", identity.EnvelopeSha256);
            Assert.Equal("7251088273845452307", identity.PostgresInstance.SystemIdentifier);

            using JsonDocument validDocument = JsonDocument.Parse(validEnvelope);
            string catalogDigest = validDocument.RootElement.GetProperty("catalogDigest").GetString()!;
            string imageReference = validDocument.RootElement.GetProperty("actual").GetProperty("services")[0]
                .GetProperty("imageReference").GetString()!;
            foreach (string invalidEnvelope in new[]
            {
                validEnvelope.Replace(catalogDigest, $"sha256:{new string('c', 64)}", StringComparison.Ordinal),
                validEnvelope.Replace(imageReference, $"postgres@sha256:{new string('c', 64)}", StringComparison.Ordinal),
                validEnvelope.Replace($"sha256:{new string('b', 64)}", "sha256:not-a-digest", StringComparison.Ordinal),
                validEnvelope.Replace("postgres (PostgreSQL) 16.15", "postgres (PostgreSQL) 15.0", StringComparison.Ordinal),
                validEnvelope.Replace("issue-3105-network", string.Empty, StringComparison.Ordinal),
                validEnvelope.Replace("\"nanoCpus\":0", "\"nanoCpus\":-1", StringComparison.Ordinal),
                validEnvelope.Replace("\"username\":\"fsusblog\"", "\"username\":\"postgres\"", StringComparison.Ordinal),
                validEnvelope.Replace("\"serverVersionNumber\":\"160015\"", "\"serverVersionNumber\":\"150000\"", StringComparison.Ordinal)
            })
            {
                File.WriteAllText(envelopeFile, invalidEnvelope);
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                        envelopeFile,
                        catalogFile,
                        RunId,
                        databaseIdentity));
            }
            File.WriteAllText(envelopeFile, validEnvelope);

            Assert.Contains(
                "service_envelope_invalid",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                        envelopeFile,
                        catalogFile,
                        "wrong-run",
                        databaseIdentity)).Message,
                StringComparison.Ordinal);

            File.WriteAllText(envelopeFile, ServiceEnvelopeJson(catalogFile, RunId, "35416"));
            Assert.Contains(
                "port_mismatch",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                        envelopeFile,
                        catalogFile,
                        RunId,
                        databaseIdentity)).Message,
                StringComparison.Ordinal);

            string tamperedEnvelope = ServiceEnvelopeJson(catalogFile, RunId, "35415");
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
                        catalogFile,
                        RunId,
                        databaseIdentity)).Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }

    [Fact]
    public void TestMaterializerServiceEnvelope_BindsPostgresIdentityAcrossMultiServiceTopology()
    {
        string sandbox = Path.Combine(Path.GetTempPath(), $"fsusblog-current-schema-multi-service-{Guid.NewGuid():N}");
        Directory.CreateDirectory(sandbox);
        string envelopeFile = Path.Combine(sandbox, "services.json");
        string catalogFile = RepositoryFile("config", "testing", "test-execution-service-catalog.json");
        try
        {
            const string RunId = "issue-3128-run";
            CurrentSchemaTestDatabaseIdentity databaseIdentity = CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                "Host=127.0.0.1;Port=35415;Database=fsusblog;Username=fsusblog;Password=test;Search Path=public");
            string validEnvelope = ServiceEnvelopeJson(catalogFile, RunId, "35415", includeRedis: true);
            File.WriteAllText(envelopeFile, validEnvelope);

            CurrentSchemaTestServiceIdentity identity = CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                envelopeFile,
                catalogFile,
                RunId,
                databaseIdentity);
            Assert.Equal(new string('a', 64), identity.ContainerId);
            Assert.Equal(35415, identity.HostPort);
            Assert.Equal("7251088273845452307", identity.PostgresInstance.SystemIdentifier);

            void AssertEnvelopeFailure(string envelope, string expectedError)
            {
                File.WriteAllText(envelopeFile, envelope);
                Assert.Contains(
                    expectedError,
                    Assert.Throws<InvalidOperationException>(() =>
                        CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                            envelopeFile,
                            catalogFile,
                            RunId,
                            databaseIdentity)).Message,
                    StringComparison.Ordinal);
            }

            AssertEnvelopeFailure(
                MutateServiceEnvelope(validEnvelope, "redis", static service => service.Remove("containerId")),
                "service_envelope_invalid");
            AssertEnvelopeFailure(
                MutateServiceEnvelope(validEnvelope, "redis", static service =>
                    service["databaseIdentity"] = JsonNode.Parse("""
                        {
                            "systemIdentifier": "7251088273845452307",
                            "database": "fsusblog",
                            "username": "fsusblog",
                            "serverVersion": "16.15",
                            "serverVersionNumber": "160015"
                        }
                        """)),
                "service_envelope_shape_invalid");
            AssertEnvelopeFailure(
                MutateServiceEnvelope(validEnvelope, "postgres", static service => service.Remove("databaseIdentity")),
                "service_envelope_shape_invalid");
            AssertEnvelopeFailure(
                MutateServiceTopology(validEnvelope, "redis", duplicate: false),
                "service_envelope_topology_mismatch");
            AssertEnvelopeFailure(
                MutateServiceTopology(validEnvelope, "redis", duplicate: true),
                "service_envelope_topology_mismatch");
        }
        finally
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }

    private static string ServiceEnvelopeJson(
        string catalogFile,
        string runId,
        string hostPort,
        bool includeRedis = false)
    {
        using JsonDocument catalog = JsonDocument.Parse(File.ReadAllText(catalogFile));
        string catalogDigest = CurrentSchemaTestMaterializer.ComputeCanonicalJsonDigest(catalog.RootElement);
        string imageReference = catalog.RootElement.GetProperty("services").GetProperty("postgres")
            .GetProperty("imageReference").GetString()!;
        string redisImageReference = catalog.RootElement.GetProperty("services").GetProperty("redis")
            .GetProperty("imageReference").GetString()!;
        var databaseIdentity = new
        {
            systemIdentifier = "7251088273845452307",
            database = "fsusblog",
            username = "fsusblog",
            serverVersion = "16.15",
            serverVersionNumber = "160015"
        };
        var service = new
        {
            id = "postgres",
            kind = "container",
            containerId = new string('a', 64),
            createdAt = "2026-08-30T00:00:00.000000000Z",
            imageReference,
            imageId = $"sha256:{new string('b', 64)}",
            repositoryDigest = imageReference,
            serviceVersion = "postgres (PostgreSQL) 16.15",
            networkMode = "issue-3105-network",
            networkNamespace = "/var/run/docker/netns/issue-3105",
            ports = new[] { new { containerPort = "5432/tcp", hostIp = "127.0.0.1", hostPort } },
            resourceLimits = new
            {
                nanoCpus = 0L,
                memory = 0L,
                memoryReservation = 0L,
                pidsLimit = 0L
            },
            databaseIdentity
        };
        var services = new List<object> { service };
        if (includeRedis)
        {
            services.Add(new
            {
                id = "redis",
                kind = "container",
                containerId = new string('c', 64),
                createdAt = "2026-08-30T00:00:00.000000000Z",
                imageReference = redisImageReference,
                imageId = $"sha256:{new string('d', 64)}",
                repositoryDigest = redisImageReference,
                serviceVersion = "Redis server v=7.4.11 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64",
                networkMode = "issue-3105-network",
                networkNamespace = "/var/run/docker/netns/issue-3105",
                ports = new[] { new { containerPort = "6379/tcp", hostIp = "127.0.0.1", hostPort = "36379" } },
                resourceLimits = new
                {
                    nanoCpus = 0L,
                    memory = 0L,
                    memoryReservation = 0L,
                    pidsLimit = 0L
                }
            });
        }
        var runtime = new
        {
            serverVersion = "28.0.0",
            serverId = "docker-server",
            operatingSystem = "Linux",
            architecture = "x86_64",
            cgroupDriver = "systemd"
        };
        var observation = new
        {
            runtime,
            services
        };
        return JsonSerializer.Serialize(new
        {
            schema = "fsusblog.test-execution-envelope-services.v2",
            qualificationEligible = true,
            producerId = "acceptance-runtime",
            runId,
            catalogDigest,
            requiredServices = includeRedis ? new[] { "postgres", "redis" } : new[] { "postgres" },
            planned = observation,
            actual = observation,
            admission = "planned-actual-exact",
            correctnessImagePull = "denied",
            hostFallback = "denied"
        });
    }

    private static string MutateServiceEnvelope(
        string envelope,
        string serviceId,
        Action<JsonObject> mutation)
    {
        JsonObject root = JsonNode.Parse(envelope)?.AsObject()
            ?? throw new InvalidOperationException("service envelope fixture is null");
        foreach (string observationName in new[] { "planned", "actual" })
        {
            JsonArray services = root[observationName]?["services"]?.AsArray()
                ?? throw new InvalidOperationException("service envelope fixture topology is missing");
            JsonObject service = services
                .Select(static node => node?.AsObject())
                .Single(candidate => string.Equals(
                    candidate?["id"]?.GetValue<string>(),
                    serviceId,
                    StringComparison.Ordinal))
                ?? throw new InvalidOperationException("service envelope fixture service is missing");
            mutation(service);
        }
        return root.ToJsonString();
    }

    private static string MutateServiceTopology(string envelope, string serviceId, bool duplicate)
    {
        JsonObject root = JsonNode.Parse(envelope)?.AsObject()
            ?? throw new InvalidOperationException("service envelope fixture is null");
        foreach (string observationName in new[] { "planned", "actual" })
        {
            JsonArray services = root[observationName]?["services"]?.AsArray()
                ?? throw new InvalidOperationException("service envelope fixture topology is missing");
            JsonNode service = services.Single(node => string.Equals(
                node?["id"]?.GetValue<string>(),
                serviceId,
                StringComparison.Ordinal))
                ?? throw new InvalidOperationException("service envelope fixture service is missing");
            if (duplicate)
            {
                services.Add(service.DeepClone());
            }
            else
            {
                services.Remove(service);
            }
        }
        return root.ToJsonString();
    }

    private static string RepositoryFile(params string[] parts)
    {
        string candidate = BackendTestPaths.FromRoot(parts);
        if (File.Exists(candidate))
        {
            return candidate;
        }

        throw new InvalidOperationException($"Repository file not found: {string.Join('/', parts)}");
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
            "Host=127.0.0.1;Port=5432;Database=fsusblog;Username=fsusblog;Password=test;Search Path=public");
        Assert.Equal("127.0.0.1", identity.Host);
        Assert.Equal("public", identity.SearchPath);
        const string ExpectedRunId = "issue-3105-boundary";
        string expectedReceipt = Path.Combine(
            Path.GetTempPath(),
            $"current-schema-test-materialization-{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(ExpectedRunId))).ToLowerInvariant()}.json");
        Assert.Equal(
            Path.GetFullPath(expectedReceipt),
            CurrentSchemaTestMaterializer.ResolveOutputPath(ExpectedRunId, environment));

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
                    "Host=localhost;Database=fsusblog;Username=fsusblog;Password=test;Search Path=public")).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "public_search_path_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                    "Host=127.0.0.1;Database=fsusblog;Username=fsusblog;Password=test;Search Path=test_schema,public")).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "database_mismatch",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                    "Host=127.0.0.1;Database=postgres;Username=fsusblog;Password=test;Search Path=public")).Message,
            StringComparison.Ordinal);
        Assert.Contains(
            "username_mismatch",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(
                    "Host=127.0.0.1;Database=fsusblog;Username=postgres;Password=test;Search Path=public")).Message,
            StringComparison.Ordinal);

        var missingReceiptRoot = new Dictionary<string, string?>(environment, StringComparer.Ordinal);
        missingReceiptRoot.Remove(CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable);
        Assert.Contains(
            "receipt_root_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ResolveOutputPath(ExpectedRunId, missingReceiptRoot)).Message,
            StringComparison.Ordinal);
        var relativeReceiptRoot = new Dictionary<string, string?>(environment, StringComparer.Ordinal)
        {
            [CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable] = "relative-root"
        };
        Assert.Contains(
            "receipt_root_required",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializer.ResolveOutputPath(ExpectedRunId, relativeReceiptRoot)).Message,
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
                [CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable] = Path.Combine(receiptRoot, "escape")
            };
            Assert.Contains(
                "receipt_root_not_canonical",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.ResolveOutputPath("issue-3105-symlink", environment)).Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }

    [Fact]
    public void TestMaterializerOutput_RejectsInputArtifactAliases()
    {
        string sandbox = Path.Combine(Path.GetTempPath(), $"fsusblog-current-schema-alias-{Guid.NewGuid():N}");
        Directory.CreateDirectory(sandbox);
        try
        {
            var environment = new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                [CurrentSchemaTestMaterializer.ReceiptRootEnvironmentVariable] = sandbox
            };
            string output = CurrentSchemaTestMaterializer.ResolveOutputPath("issue-3105-alias", environment);
            string sibling = Path.Combine(sandbox, "service-catalog.json");
            Assert.Contains(
                "output_alias",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.RejectArtifactAlias(output, output, sibling)).Message,
                StringComparison.Ordinal);
            Assert.Contains(
                "output_alias",
                Assert.Throws<InvalidOperationException>(() =>
                    CurrentSchemaTestMaterializer.RejectArtifactAlias(output, sibling, output)).Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }

    [Fact]
    public void CandidateVerifierCommand_RoutesExactlyAndRejectsResealedLiveDatabaseForgery()
    {
        Assert.True(CurrentSchemaTestMaterializationCandidateCommandLine.IsRequested(
            [CurrentSchemaTestMaterializationCandidateCommandLine.CommandName]));
        Assert.False(CurrentSchemaTestMaterializationCandidateCommandLine.IsRequested(
            ["serve", CurrentSchemaTestMaterializationCandidateCommandLine.CommandName]));
        var options = new CurrentSchemaTestMaterializationOptions(
            "issue-3105-candidate",
            new string('a', 40),
            "/tmp/envelope.json",
            "/tmp/catalog.json");
        var postgresInstance = new CurrentSchemaTestPostgresInstanceIdentity(
            "7251088273845452307",
            "fsusblog",
            "fsusblog",
            "16.15",
            "160015");
        var serviceIdentity = new CurrentSchemaTestServiceIdentity(
            $"sha256:{new string('b', 64)}",
            new string('c', 64),
            "acceptance-runtime",
            new string('d', 64),
            "2026-08-30T00:00:00.000000000Z",
            $"postgres@sha256:{new string('e', 64)}",
            $"sha256:{new string('f', 64)}",
            $"postgres@sha256:{new string('e', 64)}",
            "postgres (PostgreSQL) 16.15",
            "issue-3105-network",
            "/var/run/docker/netns/issue-3105",
            35415,
            new CurrentSchemaTestResourceLimits(0, 0, 0, 0),
            postgresInstance);
        var databaseIdentity = new CurrentSchemaTestDatabaseIdentity(
            "postgresql",
            "127.0.0.1",
            35415,
            "fsusblog",
            "fsusblog",
            "public");
        var canonicalIdentity = new CurrentSchemaIdentity(
            CurrentSchemaCanonicalAuthority.ModelVersion,
            CurrentSchemaCanonicalAuthority.ExtractorVersion,
            CurrentSchemaCanonicalAuthority.GeneratorVersion,
            new string('1', 64),
            new string('2', 64));
        const string ObservedDigest =
            "3333333333333333333333333333333333333333333333333333333333333333";
        string[] tables = ["article"];
        var unsigned = new CurrentSchemaTestMaterializationReceipt(
            CurrentSchemaTestMaterializer.ReceiptSchema,
            "verified",
            CurrentSchemaTestMaterializationCommandLine.CommandName,
            CurrentSchemaTestMaterializer.ProducerId,
            TestOnly: true,
            QualificationEligible: true,
            options.RunId,
            options.SourceCommit,
            serviceIdentity,
            databaseIdentity,
            canonicalIdentity,
            ObservedDigest,
            tables.Length,
            tables,
            EmptyBefore: true,
            CodeFirstApplied: true,
            StartupVerifier: "green",
            new string('4', 64),
            ReceiptDigest: string.Empty);
        CurrentSchemaTestMaterializationReceipt receipt = unsigned with
        {
            ReceiptDigest = CurrentSchemaTestMaterializationCandidateVerifier
                .ComputeMaterializationReceiptDigest(unsigned)
        };
        CurrentSchemaTestMaterializationCandidateVerifier.ValidateReceipt(
            receipt,
            options,
            serviceIdentity,
            databaseIdentity,
            canonicalIdentity,
            ObservedDigest,
            tables,
            new string('4', 64));

        CurrentSchemaTestMaterializationReceipt forged = receipt with
        {
            ObservedDatabaseDigest = new string('5', 64),
            ReceiptDigest = string.Empty
        };
        forged = forged with
        {
            ReceiptDigest = CurrentSchemaTestMaterializationCandidateVerifier
                .ComputeMaterializationReceiptDigest(forged)
        };
        Assert.Contains(
            "live_database_mismatch",
            Assert.Throws<InvalidOperationException>(() =>
                CurrentSchemaTestMaterializationCandidateVerifier.ValidateReceipt(
                    forged,
                    options,
                    serviceIdentity,
                    databaseIdentity,
                    canonicalIdentity,
                    ObservedDigest,
                    tables,
                    new string('4', 64))).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void TestMaterializerExactEmptyInventory_ObservesStandaloneCompositeExactlyOnce()
    {
        string inventorySql = CurrentSchemaTestMaterializer.PublicSchemaObjectInventorySql;
        Assert.Contains("c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')", inventorySql, StringComparison.Ordinal);
        Assert.Contains("t.typrelid = 0", inventorySql, StringComparison.Ordinal);
        Assert.Equal(1, inventorySql.Split("'relation:' || c.relkind", StringSplitOptions.None).Length - 1);
        Assert.Equal(1, inventorySql.Split("t.typrelid = 0", StringSplitOptions.None).Length - 1);
    }

    [Fact]
    public void StartupVerifierSemanticGuard_RejectsTableColumnTypeIndexAndConstraintDrift()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);

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
            new SchemaIndexModel(
                "ux_synthetic_name",
                true,
                [new SchemaIndexKeyModel("state", "asc", "last", "default", "default")],
                [],
                "btree",
                null,
                false);
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
            new SchemaIndexModel(
                "ix_synthetic_extra",
                false,
                [new SchemaIndexKeyModel("state", "asc", "last", "default", "default")],
                [],
                "btree",
                null,
                false));
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
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
        SchemaTableModel table = canonical.SemanticSchema.Tables["synthetic_table"];

        Assert.Contains("inherited_id", table.Columns.Keys);
        Assert.Contains("defaultname", table.Columns.Keys);
        Assert.DoesNotContain("ignored", table.Columns.Keys);
        Assert.DoesNotContain("notmapped", table.Columns.Keys);
        Assert.Equal("ready", table.Columns["state"].DefaultValue);
        Assert.True(table.Columns["optional_count"].IsNullable);
        Assert.Equal("json", table.Columns["payload"].DataType);
        Assert.Equal("json", table.Columns["payload"].Conversion);
        SchemaIndexModel uniqueNameIndex = table.IndexDefinitions["ux_synthetic_name"];
        SchemaIndexKeyModel uniqueNameKey = Assert.Single(uniqueNameIndex.Keys);
        Assert.Equal("defaultname", uniqueNameKey.Column);
        Assert.Equal("asc", uniqueNameKey.Direction);
        Assert.Equal("last", uniqueNameKey.NullPlacement);
        Assert.Equal("default", uniqueNameKey.OperatorClass);
        Assert.Equal("default", uniqueNameKey.Collation);
        Assert.Empty(uniqueNameIndex.IncludedColumns);
        Assert.Equal("btree", uniqueNameIndex.AccessMethod);
        Assert.Null(uniqueNameIndex.Predicate);
        Assert.False(uniqueNameIndex.NullsNotDistinct);
        Assert.True(uniqueNameIndex.IsUnique);
        Assert.Equal("primary-key", table.Constraints["pk_synthetic_table"].Kind);
        Assert.Equal("check", table.Constraints["ck_synthetic_state"].Kind);
        Assert.Equal("foreign-key", table.Constraints["fk_synthetic_parent"].Kind);

        SchemaConstraintModel foreignKey = table.Constraints["fk_synthetic_parent"];
        Assert.False(foreignKey.IsDeferrable);
        Assert.False(foreignKey.IsInitiallyDeferred);
        Assert.True(foreignKey.IsValidated);
        Assert.Equal("no-action", foreignKey.ForeignKeyUpdateAction);
        Assert.Equal("no-action", foreignKey.ForeignKeyDeleteAction);
        Assert.Equal("simple", foreignKey.ForeignKeyMatchType);
        Assert.Equal("public", foreignKey.ReferencedSchema);

        SchemaConstraintModel[] nonForeignKeys =
        [
            table.Constraints["pk_synthetic_table"],
            table.Constraints["ux_synthetic_name"],
            table.Constraints["ck_synthetic_state"]
        ];
        Assert.All(nonForeignKeys, static constraint =>
        {
            Assert.False(constraint.IsDeferrable);
            Assert.False(constraint.IsInitiallyDeferred);
            Assert.True(constraint.IsValidated);
            Assert.Null(constraint.ForeignKeyUpdateAction);
            Assert.Null(constraint.ForeignKeyDeleteAction);
            Assert.Null(constraint.ForeignKeyMatchType);
            Assert.Null(constraint.ReferencedSchema);
        });
    }

    [Fact]
    public void Comparer_BindsForeignKeyReferenceToExactSchema()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
        SchemaModelSnapshot publicReference = CurrentSchemaCanonicalAuthority.ProjectProvider(
            canonical,
            SchemaProviderKind.PostgreSql);

        Assert.Empty(SchemaModelComparer.Compare(canonical.SemanticSchema, publicReference));

        SchemaModelSnapshot sameTableInAnotherSchema = CurrentSchemaCanonicalAuthority.ProjectProvider(
            canonical,
            SchemaProviderKind.PostgreSql);
        var constraints = (Dictionary<string, SchemaConstraintModel>)sameTableInAnotherSchema
            .Tables["synthetic_table"]
            .Constraints;
        constraints["fk_synthetic_parent"] = constraints["fk_synthetic_parent"] with
        {
            ReferencedSchema = "archive"
        };

        Assert.Contains(
            SchemaModelComparer.Compare(canonical.SemanticSchema, sameTableInAnotherSchema),
            static error => error.StartsWith(
                "constraint mismatch synthetic_table.fk_synthetic_parent",
                StringComparison.Ordinal));
    }

    [Fact]
    public void Comparer_RejectsEveryConstraintExecutionSemanticDrift()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);

        void AssertConstraintDrift(
            string constraintName,
            Func<SchemaConstraintModel, SchemaConstraintModel> mutate)
        {
            SchemaModelSnapshot actual = CurrentSchemaCanonicalAuthority.ProjectProvider(
                canonical,
                SchemaProviderKind.PostgreSql);
            var constraints = (Dictionary<string, SchemaConstraintModel>)actual.Tables["synthetic_table"].Constraints;
            constraints[constraintName] = mutate(constraints[constraintName]);

            Assert.Contains(
                SchemaModelComparer.Compare(canonical.SemanticSchema, actual),
                error => error.StartsWith(
                    $"constraint mismatch synthetic_table.{constraintName}",
                    StringComparison.Ordinal));
        }

        AssertConstraintDrift("fk_synthetic_parent", static constraint => constraint with { IsDeferrable = true });
        AssertConstraintDrift("fk_synthetic_parent", static constraint => constraint with { IsInitiallyDeferred = true });
        AssertConstraintDrift("fk_synthetic_parent", static constraint => constraint with { IsValidated = false });
        AssertConstraintDrift("fk_synthetic_parent", static constraint => constraint with { ForeignKeyUpdateAction = "cascade" });
        AssertConstraintDrift("fk_synthetic_parent", static constraint => constraint with { ForeignKeyDeleteAction = "restrict" });
        AssertConstraintDrift("fk_synthetic_parent", static constraint => constraint with { ForeignKeyMatchType = "full" });
        AssertConstraintDrift("ck_synthetic_state", static constraint => constraint with { ForeignKeyUpdateAction = "no-action" });
        AssertConstraintDrift("ck_synthetic_state", static constraint => constraint with { ForeignKeyDeleteAction = "no-action" });
        AssertConstraintDrift("ck_synthetic_state", static constraint => constraint with { ForeignKeyMatchType = "simple" });
    }

    [Theory]
    [InlineData("a", "no-action")]
    [InlineData("r", "restrict")]
    [InlineData("c", "cascade")]
    [InlineData("n", "set-null")]
    [InlineData("d", "set-default")]
    public void PostgreSqlConstraintObservation_MapsForeignKeyActionsExactly(
        string observed,
        string expected)
        => Assert.Equal(expected, SchemaModelInspector.NormalizePostgresForeignKeyAction(observed));

    [Theory]
    [InlineData("s", "simple")]
    [InlineData("f", "full")]
    [InlineData("p", "partial")]
    public void PostgreSqlConstraintObservation_MapsForeignKeyMatchTypesExactly(
        string observed,
        string expected)
        => Assert.Equal(expected, SchemaModelInspector.NormalizePostgresForeignKeyMatchType(observed));

    [Fact]
    public void PostgreSqlConstraintObservation_RejectsUnknownForeignKeyCodes()
    {
        Assert.Throws<InvalidOperationException>(
            () => SchemaModelInspector.NormalizePostgresForeignKeyAction("x"));
        Assert.Throws<InvalidOperationException>(
            () => SchemaModelInspector.NormalizePostgresForeignKeyMatchType("x"));
    }

    [Fact]
    public void Extract_ModelsDescendingIndexDefaultsExactly()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(DescendingIndexEntity)]);
        SchemaIndexModel index = canonical.SemanticSchema.Tables["descending_index"].IndexDefinitions["ix_descending_state"];
        SchemaIndexKeyModel key = Assert.Single(index.Keys);

        Assert.Equal("state", key.Column);
        Assert.Equal("desc", key.Direction);
        Assert.Equal("first", key.NullPlacement);
        Assert.Equal("default", key.OperatorClass);
        Assert.Equal("default", key.Collation);
    }

    [Fact]
    public void PostgreSqlIndexObservation_ParsesEveryExactKeySemantic()
    {
        IReadOnlyList<SchemaIndexKeyModel> keys = SchemaModelInspector.ParsePostgresIndexKeys(
            """
            [{"column":"State","direction":"desc","nullPlacement":"first","operatorClass":"public.Custom_Ops","collation":"public.Custom_Collation"}]
            """,
            hasExpressions: false);
        SchemaIndexKeyModel key = Assert.Single(keys);

        Assert.Equal("state", key.Column);
        Assert.Equal("desc", key.Direction);
        Assert.Equal("first", key.NullPlacement);
        Assert.Equal("public.custom_ops", key.OperatorClass);
        Assert.Equal("public.custom_collation", key.Collation);
        Assert.Equal(
            ["payload", "state"],
            SchemaModelInspector.ParsePostgresIncludedColumns("[\"Payload\",\"State\"]"));
        Assert.Throws<InvalidOperationException>(() =>
            SchemaModelInspector.ParsePostgresIndexKeys("[]", hasExpressions: true));
    }

    [Fact]
    public void Comparer_RejectsEveryIndexSemanticDrift()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);

        void AssertIndexDrift(Func<SchemaIndexModel, SchemaIndexModel> mutate)
        {
            SchemaModelSnapshot actual = CurrentSchemaCanonicalAuthority.ProjectProvider(
                canonical,
                SchemaProviderKind.PostgreSql);
            var indexes = (Dictionary<string, SchemaIndexModel>)actual.Tables["synthetic_table"].IndexDefinitions;
            indexes["ux_synthetic_name"] = mutate(indexes["ux_synthetic_name"]);

            Assert.Contains(
                SchemaModelComparer.Compare(canonical.SemanticSchema, actual),
                static error => error.StartsWith(
                    "index mismatch synthetic_table.ux_synthetic_name",
                    StringComparison.Ordinal));
        }

        AssertIndexDrift(static index => index with { IsUnique = false });
        AssertIndexDrift(static index => index with
        {
            Keys = [index.Keys[0] with { Direction = "desc" }]
        });
        AssertIndexDrift(static index => index with
        {
            Keys = [index.Keys[0] with { NullPlacement = "first" }]
        });
        AssertIndexDrift(static index => index with
        {
            Keys = [index.Keys[0] with { OperatorClass = "public.text_pattern_ops" }]
        });
        AssertIndexDrift(static index => index with
        {
            Keys = [index.Keys[0] with { Collation = "public.custom_collation" }]
        });
        AssertIndexDrift(static index => index with { IncludedColumns = ["state"] });
        AssertIndexDrift(static index => index with { AccessMethod = "hash" });
        AssertIndexDrift(static index => index with { Predicate = "state <> ''" });
        AssertIndexDrift(static index => index with { NullsNotDistinct = true });
    }

    [Fact]
    public void Extract_FailsClosedForDuplicateAndAmbiguousOwnersOrUnsupportedConverters()
    {
        InvalidOperationException duplicateTable = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity), typeof(DuplicateTableEntity)]));
        Assert.Contains("Duplicate current schema table owner", duplicateTable.Message, StringComparison.Ordinal);

        InvalidOperationException duplicateColumn = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaEntityExtractor.Extract([typeof(AmbiguousDerivedEntity)]));
        Assert.Contains("Duplicate current schema column owner", duplicateColumn.Message, StringComparison.Ordinal);

        InvalidOperationException converter = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaEntityExtractor.Extract([typeof(UnsupportedConverterEntity)]));
        Assert.Contains("Unsupported current schema converter", converter.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ProviderProjection_SeparatesSemanticSchemaFromPhysicalDialect()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
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
    public void Comparer_StillRejectsManagedConversionDriftBetweenSemanticOwners()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
        SchemaModelSnapshot changed = CurrentSchemaCanonicalAuthority.Generate(canonical).Schema;
        var columns = (Dictionary<string, SchemaColumnModel>)changed.Tables["synthetic_table"].Columns;
        columns["payload"] = columns["payload"] with
        {
            Conversion = "none"
        };
        Assert.Contains(SchemaModelComparer.Compare(canonical.SemanticSchema, changed),
            static error => error.StartsWith("conversion mismatch synthetic_table.payload", StringComparison.Ordinal));
    }

    [Fact]
    public void PostgreSqlProviderProjection_BindsPhysicalTypesCollationAndOwnedSequence()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract(
            [typeof(PhysicalSemanticsEntity)]);
        SchemaModelSnapshot postgresql = CurrentSchemaCanonicalAuthority.ProjectProvider(
            canonical,
            SchemaProviderKind.PostgreSql);
        SchemaTableModel table = postgresql.Tables["physical_semantics"];

        Assert.Equal("timestamp without time zone", table.Columns["observed_at"].PhysicalType);
        Assert.Equal("numeric(18,2)", table.Columns["amount"].PhysicalType);
        Assert.Equal("public.code_domain", table.Columns["code"].PhysicalType);
        Assert.Equal("default", table.Columns["code"].Collation);
        Assert.Equal("n/a", table.Columns["observed_at"].Collation);
        Assert.Equal("owned-sequence-default", table.Columns["id"].GenerationKind);
        Assert.Equal(
            new SchemaOwnedSequenceModel(
                "public",
                "physical_semantics_id_seq",
                "physical_semantics",
                "id",
                "bigint",
                1,
                1,
                1,
                long.MaxValue,
                1,
                false),
            table.Columns["id"].OwnedSequence);
    }

    [Fact]
    public void Comparer_RejectsEveryPostgreSqlColumnPhysicalSemanticDrift()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract(
            [typeof(PhysicalSemanticsEntity)]);

        void AssertColumnDrift(
            string columnName,
            Func<SchemaColumnModel, SchemaColumnModel> mutate,
            string expectedDifference)
        {
            SchemaModelSnapshot expected = CurrentSchemaCanonicalAuthority.ProjectProvider(
                canonical,
                SchemaProviderKind.PostgreSql);
            SchemaModelSnapshot actual = CurrentSchemaCanonicalAuthority.ProjectProvider(
                canonical,
                SchemaProviderKind.PostgreSql);
            SchemaTableModel table = actual.Tables["physical_semantics"];
            table.Columns[columnName] = mutate(table.Columns[columnName]);

            Assert.Contains(
                SchemaModelComparer.Compare(expected, actual),
                error => error.StartsWith(
                    $"{expectedDifference} mismatch physical_semantics.{columnName}",
                    StringComparison.Ordinal));
        }

        AssertColumnDrift("observed_at", static column => column with { DefaultValue = "now()" }, "default");
        AssertColumnDrift("observed_at", static column => column with { PhysicalType = "timestamp(0) without time zone" }, "physical-type");
        AssertColumnDrift("amount", static column => column with { PhysicalType = "numeric(19,2)" }, "physical-type");
        AssertColumnDrift("code", static column => column with { PhysicalType = "public.other_domain" }, "physical-type");
        AssertColumnDrift("code", static column => column with { Collation = "public.custom_collation" }, "collation");
        AssertColumnDrift("id", static column => column with { GenerationKind = "identity-by-default" }, "generation");

        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                Schema = "private"
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                Name = "other_seq"
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                OwnedTable = "other_table"
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                OwnedColumn = "other_id"
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                DataType = "integer"
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                StartValue = 2
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                IncrementBy = 2
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                MinValue = 0
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                MaxValue = long.MaxValue - 1
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                CacheSize = 2
            }
        }, "owned-sequence");
        AssertColumnDrift("id", static column => column with
        {
            OwnedSequence = column.OwnedSequence! with
            {
                IsCyclic = true
            }
        }, "owned-sequence");
    }

    [Theory]
    [InlineData("", null, false, "none")]
    [InlineData("", "nextval('public.test_id_seq'::regclass)", true, "owned-sequence-default")]
    [InlineData("d", null, true, "identity-by-default")]
    [InlineData("a", null, true, "identity-always")]
    public void PostgreSqlColumnObservation_MapsGenerationKindsExactly(
        string identityKind,
        string? rawDefault,
        bool hasOwnedSequence,
        string expected)
        => Assert.Equal(
            expected,
            SchemaModelInspector.ResolvePostgresGenerationKind(
                identityKind,
                rawDefault,
                hasOwnedSequence));

    [Fact]
    public void PostgreSqlColumnObservation_RejectsIncompleteGenerationAndCollation()
    {
        Assert.Throws<InvalidOperationException>(() =>
            SchemaModelInspector.ResolvePostgresGenerationKind("", null, hasOwnedSequence: true));
        Assert.Throws<InvalidOperationException>(() =>
            SchemaModelInspector.ResolvePostgresGenerationKind(
                "d",
                "nextval('public.test_id_seq'::regclass)",
                hasOwnedSequence: true));
        Assert.Throws<InvalidOperationException>(() =>
            SchemaModelInspector.ResolvePostgresGenerationKind("x", null, hasOwnedSequence: true));
        Assert.Throws<InvalidOperationException>(() =>
            SchemaModelInspector.NormalizePostgresCollation("custom_collation"));
    }

    [Theory]
    [InlineData("timestamp without time zone", "timestamp without time zone")]
    [InlineData("timestamp(6) without time zone", "timestamp without time zone")]
    [InlineData("timestamp ( 6 ) with time zone", "timestamp with time zone")]
    [InlineData("timestamp(0) without time zone", "timestamp(0) without time zone")]
    [InlineData("timestamp(3) without time zone", "timestamp(3) without time zone")]
    public void PostgreSqlColumnObservation_NormalizesOnlyDefaultTimestampPrecision(
        string observed,
        string expected)
        => Assert.Equal(expected, SchemaModelInspector.NormalizePostgresPhysicalType(observed));

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
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(canonical);
        projection.Schema.Tables["synthetic_table"].Columns["defaultname"] =
            projection.Schema.Tables["synthetic_table"].Columns["defaultname"] with
            {
                MaxLength = 65
            };

        InvalidOperationException tamper = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaCanonicalAuthority.Generate(new CurrentSchemaCanonicalModel(projection.Schema, projection.Identity)));
        Assert.Contains("content digest mismatch", tamper.Message, StringComparison.Ordinal);

        CurrentSchemaCanonicalModel changed = CurrentSchemaEntityExtractor.Extract([typeof(ChangedSyntheticEntity)]);
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
        CurrentSchemaCanonicalModel baseline = CurrentSchemaEntityExtractor.Extract([typeof(SourceDigestBaselineEntity)]);
        CurrentSchemaCanonicalModel indexChanged = CurrentSchemaEntityExtractor.Extract([typeof(SourceDigestIndexChangedEntity)]);
        CurrentSchemaCanonicalModel constraintChanged = CurrentSchemaEntityExtractor.Extract([typeof(SourceDigestConstraintChangedEntity)]);

        Assert.NotEqual(baseline.Identity.SourceDigest, indexChanged.Identity.SourceDigest);
        Assert.NotEqual(baseline.Identity.ContentDigest, indexChanged.Identity.ContentDigest);
        Assert.NotEqual(baseline.Identity.SourceDigest, constraintChanged.Identity.SourceDigest);
        Assert.NotEqual(baseline.Identity.ContentDigest, constraintChanged.Identity.ContentDigest);
    }

    [Fact]
    public void Comparer_EmitsExactOwnedDifferences()
    {
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
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
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
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
            Keys = [indexes["ux_synthetic_name"].Keys[0] with { Column = "state" }]
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
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(SyntheticEntity)]);
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

    [SugarTable("descending_index")]
    [SugarIndex("ix_descending_state", nameof(State), OrderByType.Desc)]
    public sealed class DescendingIndexEntity
    {
        public string State { get; set; } = string.Empty;
    }

    [SugarTable("physical_semantics")]
    public sealed class PhysicalSemanticsEntity
    {
        [SugarColumn(ColumnName = "id", IsPrimaryKey = true, IsIdentity = true)]
        public long Id
        {
            get; set;
        }

        [SugarColumn(ColumnName = "observed_at")]
        public DateTime ObservedAt
        {
            get; set;
        }

        [SugarColumn(ColumnName = "amount", ColumnDataType = "numeric(18, 2)")]
        public decimal Amount
        {
            get; set;
        }

        [SugarColumn(ColumnName = "code", ColumnDataType = "public.code_domain")]
        public string Code { get; set; } = string.Empty;
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
