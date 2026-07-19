using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IAdminBackupStatusReader
{
    BackupStatusResponse GetStatus();
}

internal sealed class AdminBackupStatusReader(
    IWebHostEnvironment environment,
    IConfiguration configuration) : IAdminBackupStatusReader
{
    public BackupStatusResponse GetStatus()
    {
        string backupRoot = ResolveBackupRoot();
        Directory.CreateDirectory(backupRoot);
        string dataRoot = ResolveDataRoot();
        string keyRingPath = ResolveDataProtectionKeyRingPath(dataRoot);

        List<BackupArtifactResponse> artifacts =
        [
            FindLatestArtifact(backupRoot, "database", ["database", "postgres", "db"], ["*.dump", "*.backup", "*.sql", "*.sql.gz"]),
            FindLatestArtifact(backupRoot, "uploads", ["uploads"], ["*.tar", "*.tar.gz", "*.tgz"]),
            FindLatestArtifact(backupRoot, "data-protection-keyring", ["data-protection", "keyring"], ["*.tar", "*.tar.gz", "*.tgz"]),
            FindLatestArtifact(backupRoot, "config", ["config", "appsettings"], ["*.json", "*.tar", "*.tar.gz", "*.tgz"]),
            FindLatestArtifact(backupRoot, "site-package", ["fsusblog-site", "site-package"], ["*.tar.gz", "*.tgz"]),
            FindRestoreDrillArtifact(backupRoot)
        ];

        if (Directory.Exists(keyRingPath) && artifacts[2].Status == "missing")
        {
            artifacts[2] = DirectoryArtifact(
                "data-protection-keyring",
                keyRingPath,
                "live-keyring-not-yet-packaged");
        }

        string status = artifacts
            .Where(static item => item.Kind is "database" or "uploads" or "data-protection-keyring" or "config")
            .All(static item => item.Status != "missing")
                ? "ok"
                : "missing";

        return new BackupStatusResponse(
            status,
            DateTimeOffset.UtcNow,
            backupRoot,
            artifacts,
            "tools/operations/backup-restore-drill.sh",
            "tools/operations/restore-site.sh --backup <package> --confirm");
    }

    private static BackupArtifactResponse FindLatestArtifact(
        string backupRoot,
        string kind,
        string[] nameHints,
        string[] patterns)
    {
        FileInfo? latest = null;
        foreach (string pattern in patterns)
        {
            foreach (string file in Directory.EnumerateFiles(backupRoot, pattern, SearchOption.AllDirectories))
            {
                string fileName = Path.GetFileName(file);
                if (!nameHints.Any(hint => fileName.Contains(hint, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }

                var info = new FileInfo(file);
                if (latest is null || info.LastWriteTimeUtc > latest.LastWriteTimeUtc)
                {
                    latest = info;
                }
            }
        }

        return latest is null
            ? new BackupArtifactResponse(kind, "missing", null, null, null, "not_found")
            : new BackupArtifactResponse(kind, "ok", latest.FullName, latest.LastWriteTimeUtc, latest.Length, "latest");
    }

    private BackupArtifactResponse FindRestoreDrillArtifact(string backupRoot)
    {
        string[] candidates =
        [
            Path.Combine(backupRoot, "backup-restore-drill.json"),
            Path.Combine(environment.ContentRootPath, ".tmp", "operations", "backup-restore-drill.json")
        ];
        string? path = candidates.FirstOrDefault(File.Exists);
        return path is null
            ? new BackupArtifactResponse("restore-drill", "missing", null, null, null, "not_run")
            : new BackupArtifactResponse(
                "restore-drill",
                "ok",
                path,
                File.GetLastWriteTimeUtc(path),
                new FileInfo(path).Length,
                "latest-report");
    }

    private static BackupArtifactResponse DirectoryArtifact(string kind, string path, string detail)
        => new(kind, "ok", path, Directory.GetLastWriteTimeUtc(path), null, detail);

    private string ResolveBackupRoot()
        => configuration["Operations:BackupRoot"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_BACKUP_ROOT")
            ?? Path.Combine(ResolveDataRoot(), "backups");

    private string ResolveDataRoot()
        => configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");

    private string ResolveDataProtectionKeyRingPath(string dataRoot)
        => configuration["DataProtection:KeyRingPath"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_PROTECTION_KEY_RING")
            ?? Path.Combine(dataRoot, "data-protection-keys");
}
