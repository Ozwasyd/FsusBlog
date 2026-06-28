using FsusBlog.Server.Tests.TestInfrastructure;
using System.Diagnostics;

namespace FsusBlog.Server.Tests;

public sealed class OperationsReadinessContractTests
{
    [Fact]
    public void AuthoringEndpoints_ExposeOpsCacheAndIntegritySurfaces()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string endpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));
        string router = File.ReadAllText(Path.Combine(root, "src/frontend/src/router/index.ts"));
        string nav = File.ReadAllText(Path.Combine(root, "src/frontend/src/layouts/accountNav.ts"));

        Assert.Contains("MapGet(\"/ops/health\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/cache/diagnostics\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/cache/actions\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/integrity\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/integrity/fix\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Mfa-Proof", endpoints, StringComparison.Ordinal);

        Assert.Contains("manage/ops", router, StringComparison.Ordinal);
        Assert.Contains("manage/cache", router, StringComparison.Ordinal);
        Assert.Contains("manage/integrity", router, StringComparison.Ordinal);
        Assert.Contains("/user/manage/ops", nav, StringComparison.Ordinal);
        Assert.Contains("/user/manage/cache", nav, StringComparison.Ordinal);
        Assert.Contains("/user/manage/integrity", nav, StringComparison.Ordinal);
    }

    [Fact]
    public void CacheDiagnostics_ExposesArticlePolicyOwnershipAndRuntimeCounters()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string catalogPath = Path.Combine(root, "src/backend/Infrastructure/Cache/ArticleCacheOwnershipCatalog.cs");
        string dtos = File.ReadAllText(Path.Combine(root, "src/backend/Models/Dtos/OperationsDtos.cs"));
        string operations = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Operations/AdminOperationsService.cs"));

        Assert.True(File.Exists(catalogPath), "Article cache policies must have an ownership catalog.");
        string catalog = File.ReadAllText(catalogPath);
        foreach (string policy in new[]
        {
            "ArticleList",
            "ArticleListFrame",
            "ArticleDetail",
            "ArticleDetailFrame",
            "ArticleHot",
            "ArticleHotFrame",
            "ArticleSearch"
        })
        {
            Assert.Contains($"CachePolicyId.{policy}", catalog, StringComparison.Ordinal);
        }

        Assert.Contains("ArticleCachePolicyDiagnosticsResponse", dtos, StringComparison.Ordinal);
        Assert.Contains("IReadOnlyList<ArticleCachePolicyDiagnosticsResponse> ArticlePolicies", dtos, StringComparison.Ordinal);
        Assert.Contains("ArticleCacheOwnershipCatalog.Policies", operations, StringComparison.Ordinal);
        Assert.Contains("GetPolicyStorageSnapshotsAsync", operations, StringComparison.Ordinal);
        Assert.Contains("FsusObservability.GetCacheOperationCounters", operations, StringComparison.Ordinal);
    }

    [Fact]
    public void BackupRestoreAndSupplyChainScripts_AreDocumentedAndExecutable()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string operations = File.ReadAllText(Path.Combine(root, "docs/operations.md"));
        string security = File.ReadAllText(Path.Combine(root, "docs/security.md"));

        AssertScriptExists(root, "tools/operations/backup-site.sh");
        AssertScriptExists(root, "tools/operations/restore-site.sh");
        AssertScriptExists(root, "tools/operations/backup-restore-drill.sh");
        AssertScriptExists(root, "tools/security/check-supply-chain-audit.sh");
        AssertScriptExists(root, "tools/security/generate-sbom.sh");

        Assert.Contains("backup-site.sh", operations, StringComparison.Ordinal);
        Assert.Contains("restore-site.sh", operations, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_SITE_BACKUP_PACKAGE", operations, StringComparison.Ordinal);
        Assert.Contains("Migration Recovery", operations, StringComparison.Ordinal);
        Assert.Contains("Supply Chain", operations, StringComparison.Ordinal);
        Assert.Contains("Secret Rotation And Recovery", security, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Host=db.internal;Port=15432;Database=fsusblog;Username=fsus_user;Password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("postgres://fsus_user:fsus_pw@db.internal:15432/fsusblog", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("host=db.internal port=15432 dbname=fsusblog user=fsus_user password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    public void BackupScript_ParsesSupportedPostgresConnectionStringStyles(
        string connectionString,
        string expectedHost,
        string expectedPort,
        string expectedDatabase,
        string expectedUser,
        string expectedPassword)
    {
        using ScriptHarness harness = ScriptHarness.Create();

        string result = harness.RunBackup(connectionString);

        Assert.Contains($"PGPASSWORD={expectedPassword}", result, StringComparison.Ordinal);
        Assert.Contains($" -h {expectedHost} ", result, StringComparison.Ordinal);
        Assert.Contains($" -p {expectedPort} ", result, StringComparison.Ordinal);
        Assert.Contains($" -U {expectedUser} ", result, StringComparison.Ordinal);
        Assert.Contains($" -d {expectedDatabase} ", result, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Host=db.internal;Port=15432;Database=fsusblog;Username=fsus_user;Password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("postgres://fsus_user:fsus_pw@db.internal:15432/fsusblog", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    [InlineData("host=db.internal port=15432 dbname=fsusblog user=fsus_user password=fsus_pw", "db.internal", "15432", "fsusblog", "fsus_user", "fsus_pw")]
    public void RestoreScript_ParsesSupportedPostgresConnectionStringStyles(
        string connectionString,
        string expectedHost,
        string expectedPort,
        string expectedDatabase,
        string expectedUser,
        string expectedPassword)
    {
        using ScriptHarness harness = ScriptHarness.Create();

        string result = harness.RunRestore(connectionString);

        Assert.Contains($"PGPASSWORD={expectedPassword}", result, StringComparison.Ordinal);
        Assert.Contains($" -h {expectedHost} ", result, StringComparison.Ordinal);
        Assert.Contains($" -p {expectedPort} ", result, StringComparison.Ordinal);
        Assert.Contains($" -U {expectedUser} ", result, StringComparison.Ordinal);
        Assert.Contains($" -d {expectedDatabase} ", result, StringComparison.Ordinal);
    }

    [Fact]
    public void HistoricalResidueCheck_CoversOperationsConnectionStringParsing()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools", "check-historical-residue.sh");

        Assert.Contains("operations connection string key parsing", source, StringComparison.Ordinal);
        Assert.Contains("tools/operations", source, StringComparison.Ordinal);
    }

    [Fact]
    public void BackupRestoreDrill_AlwaysPlansAnonymousResidueGateAndRestoreManifest()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string drill = File.ReadAllText(Path.Combine(root, "tools/operations/backup-restore-drill.sh"));
        string operations = File.ReadAllText(Path.Combine(root, "docs/operations.md"));

        Assert.Contains("backup-restore-anonymous-residue.json", drill, StringComparison.Ordinal);
        Assert.Contains("backup-restore-manifest.json", drill, StringComparison.Ordinal);
        Assert.Contains("run_anonymous_residue_gate", drill, StringComparison.Ordinal);
        Assert.Contains("tools/check-historical-residue.sh", drill, StringComparison.Ordinal);
        Assert.Contains("anonymous-residue-gate", drill, StringComparison.Ordinal);
        Assert.Contains("restore-manifest", drill, StringComparison.Ordinal);
        Assert.Contains("postgres", drill, StringComparison.Ordinal);
        Assert.Contains("redis", drill, StringComparison.Ordinal);
        Assert.Contains("search", drill, StringComparison.Ordinal);
        Assert.Contains("aot-static", drill, StringComparison.Ordinal);
        Assert.Contains("uploads-manifest", drill, StringComparison.Ordinal);
        Assert.Contains("anonymous residue gate", operations, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("backup-restore-anonymous-residue.json", operations, StringComparison.Ordinal);
        Assert.Contains("backup-restore-manifest.json", operations, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicDistributionAndSearch_KeepNonPublicContentOut()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string distribution = File.ReadAllText(Path.Combine(root, "src/backend/Services/Distribution/BlogDistributionService.cs"));
        string search = File.ReadAllText(Path.Combine(root, "src/backend/Services/SearchIndexService.cs"));
        string operationsService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Operations/AdminOperationsService.cs"));

        Assert.Contains("article.Status == ArticleStatus.Published", distribution, StringComparison.Ordinal);
        Assert.Contains("article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now", distribution, StringComparison.Ordinal);
        Assert.Contains("Queryable<Category, Article>", distribution, StringComparison.Ordinal);
        Assert.Contains("Queryable<Tag, ArticleTag, Article>", distribution, StringComparison.Ordinal);

        Assert.Contains("a.Status == ArticleStatus.Published", search, StringComparison.Ordinal);
        Assert.Contains("a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now", search, StringComparison.Ordinal);
        Assert.Contains("search_visibility", operationsService, StringComparison.Ordinal);
        Assert.Contains("sitemap_visibility", operationsService, StringComparison.Ordinal);
    }

    [Fact]
    public void OpsHealthDistributionDiagnostics_UseLightweightCountsInsteadOfXmlBuildAndParse()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string distribution = File.ReadAllText(Path.Combine(root, "src/backend/Services/Distribution/BlogDistributionService.cs"));
        string operationsService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Operations/AdminOperationsService.cs"));
        string observability = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Observability/FsusObservability.cs"));
        string diagnosticsMethod = ExtractMethodBlock(operationsService, "private async Task<DistributionDiagnosticsResponse> GetDistributionDiagnosticsAsync");

        Assert.DoesNotContain("BuildSitemapAsync", diagnosticsMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildRssAsync", diagnosticsMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("XDocument.Parse", diagnosticsMethod, StringComparison.Ordinal);
        Assert.Contains("GetDiagnosticsCountsAsync", diagnosticsMethod, StringComparison.Ordinal);

        Assert.Contains("GetDiagnosticsCountsAsync", distribution, StringComparison.Ordinal);
        Assert.Contains("DiagnosticsCacheTtl", distribution, StringComparison.Ordinal);
        Assert.Contains("CountSitemapUrlsAsync", distribution, StringComparison.Ordinal);
        Assert.Contains("CountFeedItemsAsync", distribution, StringComparison.Ordinal);
        Assert.Contains("FeedLimit", distribution, StringComparison.Ordinal);

        Assert.Contains("fsus.distribution.diagnostics.elapsed_ms", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.distribution.diagnostics.cache_access", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.distribution.diagnostics.db_command_count", observability, StringComparison.Ordinal);
    }

    [Fact]
    public void DangerousOperations_RequireDiffConfirmationAdminStepUpAndAudit()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string operationsService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Operations/AdminOperationsService.cs"));
        string endpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));

        Assert.Contains("APPLY_SAFE_FIXES", operationsService, StringComparison.Ordinal);
        Assert.Contains("DangerousOperationPolicyResponse", operationsService, StringComparison.Ordinal);
        Assert.Contains("diff-preview", operationsService, StringComparison.Ordinal);
        Assert.Contains("admin-step-up", operationsService, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("admin.integrity.safe_fix_applied", endpoints, StringComparison.Ordinal);
        Assert.Contains("RecordHighValueAsync", endpoints, StringComparison.Ordinal);
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"{signature} missing");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart >= 0, $"{signature} body missing");

        int depth = 0;
        for (int index = braceStart; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
            }
            else if (character == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[braceStart..(index + 1)];
                }
            }
        }

        Assert.Fail($"{signature} body not closed");
        return string.Empty;
    }

    private static void AssertScriptExists(string root, string relativePath)
    {
        string path = Path.Combine(root, relativePath);
        Assert.True(File.Exists(path), $"{relativePath} missing");
        string firstLine = File.ReadLines(path).FirstOrDefault() ?? string.Empty;
        Assert.StartsWith("#!/usr/bin/env bash", firstLine, StringComparison.Ordinal);
    }

    private sealed class ScriptHarness : IDisposable
    {
        private readonly string _root;
        private readonly string _binDir;
        private readonly string _backupRoot;
        private readonly string _restoreRoot;
        private readonly string _dataRoot;
        private readonly string _webRoot;
        private readonly string _resultPath;

        private ScriptHarness(string root)
        {
            _root = root;
            _binDir = Path.Combine(root, "bin");
            _backupRoot = Path.Combine(root, "backup");
            _restoreRoot = Path.Combine(root, "restore");
            _dataRoot = Path.Combine(root, "data");
            _webRoot = Path.Combine(root, "wwwroot");
            _resultPath = Path.Combine(root, "pg-result.txt");
        }

        public static ScriptHarness Create()
        {
            string root = Path.Combine(Path.GetTempPath(), "fsusblog-ops-script-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            ScriptHarness harness = new(root);
            harness.Initialize();
            return harness;
        }

        public string RunBackup(string connectionString)
        {
            RunBashFunction(
                "source <(sed '$d' tools/operations/backup-site.sh); WORK_DIR=\"$1\"; dump_database",
                connectionString,
                [_backupRoot]);
            return File.ReadAllText(_resultPath);
        }

        public string RunRestore(string connectionString)
        {
            Directory.CreateDirectory(Path.Combine(_restoreRoot, "package"));
            File.WriteAllText(Path.Combine(_restoreRoot, "package", "database.dump"), "dump");
            RunBashFunction(
                "set --; source <(sed '$d' tools/operations/restore-site.sh); restore_database",
                connectionString,
                []);
            return File.ReadAllText(_resultPath);
        }

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }

        private void Initialize()
        {
            Directory.CreateDirectory(_binDir);
            Directory.CreateDirectory(Path.Combine(_dataRoot, "data-protection-keys"));
            Directory.CreateDirectory(Path.Combine(_webRoot, "uploads"));
            Directory.CreateDirectory(Path.Combine(_webRoot, "aot-cache"));
            Directory.CreateDirectory(Path.Combine(_webRoot, "search"));
            File.WriteAllText(Path.Combine(_dataRoot, "data-protection-keys", "key.xml"), "<key />");
            WriteCaptureCommand("pg_dump");
            WriteCaptureCommand("pg_restore");
        }

        private void WriteCaptureCommand(string name)
        {
            string path = Path.Combine(_binDir, name);
            File.WriteAllText(path, """
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'PGPASSWORD=%s\n' "${PGPASSWORD-}"
  printf 'ARGS='
  printf ' %s' "$@"
  printf '\n'
} > "${FSUSBLOG_CAPTURE_PATH:?}"
for arg in "$@"; do
  case "$arg" in
    --file=*)
      mkdir -p "$(dirname "${arg#--file=}")"
      printf 'dump' > "${arg#--file=}"
      ;;
  esac
done
""");
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }

        private void RunBashFunction(string command, string connectionString, IReadOnlyList<string> args)
        {
            List<string> bashArgs = ["-c", command, "_"];
            bashArgs.AddRange(args);
            RunProcess("bash", bashArgs, connectionString);
        }

        private void RunProcess(string fileName, IReadOnlyList<string> args, string connectionString)
        {
            string root = BackendTestPaths.RepositoryRoot;
            using Process process = new()
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    WorkingDirectory = root,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true
                }
            };

            foreach (string arg in args)
            {
                process.StartInfo.ArgumentList.Add(arg);
            }

            process.StartInfo.Environment["PATH"] = _binDir + Path.PathSeparator + (Environment.GetEnvironmentVariable("PATH") ?? string.Empty);
            process.StartInfo.Environment["FSUSBLOG_CAPTURE_PATH"] = _resultPath;
            process.StartInfo.Environment["FSUSBLOG_BACKUP_ROOT"] = _backupRoot;
            process.StartInfo.Environment["FSUSBLOG_BACKUP_RUN_ID"] = "test";
            process.StartInfo.Environment["FSUSBLOG_BACKUP_PACKAGE"] = Path.Combine(_backupRoot, "site.tar.gz");
            process.StartInfo.Environment["FSUSBLOG_RESTORE_ROOT"] = _restoreRoot;
            process.StartInfo.Environment["FSUSBLOG_RESTORE_RUN_ID"] = "test";
            process.StartInfo.Environment["FSUSBLOG_DATA_ROOT"] = _dataRoot;
            process.StartInfo.Environment["FSUSBLOG_WEB_ROOT"] = _webRoot;
            process.StartInfo.Environment["ConnectionStrings__DefaultConnection"] = connectionString;

            process.Start();
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, $"{fileName} failed with {process.ExitCode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}");
        }
    }
}
