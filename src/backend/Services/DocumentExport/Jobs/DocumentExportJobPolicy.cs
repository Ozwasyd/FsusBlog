namespace FsusBlog.Server.Services.DocumentExport.Jobs;

/// <summary>
/// Closed bounded custody policy. Explicit deletion revokes immediately; logout
/// and site switch revoke session grants but retain private results until TTL.
/// Grant reuse, ranges, public sharing and qualifying retries are disabled.
/// </summary>
public static class DocumentExportJobPolicy
{
    public const string SnapshotSchema = "fsusblog.document-export-job.v2";
    public const string OutputSchema = "fsusblog.document-export-output.v2";
    public const int MaximumJobs = 128;
    public const int MaximumOwnerJobs = 16;
    public const int MaximumSiteJobs = 64;
    public const int MaximumGrants = 128;
    public const int MaximumOwnerGrants = 8;
    public const int MaximumAttempts = 3;
    public const long MaximumInputBytes = 8 * 1024 * 1024;
    public const long MaximumTotalInputBytes = 32 * 1024 * 1024;
    public const long MaximumOutputBytes = 64 * 1024 * 1024;
    public const long MaximumOwnerOutputBytes = 128 * 1024 * 1024;
    public const long MaximumSiteOutputBytes = 256 * 1024 * 1024;
    public const long MaximumTotalOutputBytes = 512 * 1024 * 1024;
    public static readonly TimeSpan JobTtl = TimeSpan.FromHours(24);
    public static readonly TimeSpan GrantTtl = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan TombstoneTtl = TimeSpan.FromHours(24);
}
