namespace FsusBlog.Server.Infrastructure.Storage;

public sealed record DataProtectionKeyRingProbeResult(
    bool Ready,
    string ApplicationName,
    string KeyRingPath,
    bool DirectoryExists,
    bool CanRead,
    bool CanWrite,
    IReadOnlyList<string> Errors);

/// <summary>
/// Probes shared DataProtection storage without exposing key material or key names.
/// The temporary probe file is instance-specific and is always removed.
/// </summary>
public static class DataProtectionKeyRingProbe
{
    public static DataProtectionKeyRingProbeResult Inspect(string keyRingPath, string applicationName)
    {
        var errors = new List<string>();
        string normalizedPath;
        try
        {
            normalizedPath = Path.GetFullPath(keyRingPath);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return new DataProtectionKeyRingProbeResult(
                false,
                applicationName,
                keyRingPath,
                false,
                false,
                false,
                ["DataProtection key-ring path is invalid."]);
        }

        if (!string.Equals(
                applicationName,
                ReleaseStorageLayout.RequiredDataProtectionApplicationName,
                StringComparison.Ordinal))
        {
            errors.Add($"DataProtection application name must be '{ReleaseStorageLayout.RequiredDataProtectionApplicationName}'.");
        }

        bool directoryExists = Directory.Exists(normalizedPath);
        bool canRead = false;
        bool canWrite = false;
        if (!directoryExists)
        {
            errors.Add("Shared DataProtection key-ring directory does not exist.");
        }
        else
        {
            try
            {
                _ = Directory.EnumerateFiles(normalizedPath, "*.xml", SearchOption.TopDirectoryOnly).Take(1).ToArray();
                canRead = true;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                errors.Add("Shared DataProtection key-ring directory is not readable.");
            }

            string probePath = Path.Combine(normalizedPath, $".fsus-probe-{Environment.ProcessId}-{Guid.NewGuid():N}.tmp");
            try
            {
                using (var stream = new FileStream(probePath, new FileStreamOptions
                {
                    Mode = FileMode.CreateNew,
                    Access = FileAccess.Write,
                    Share = FileShare.None,
                    BufferSize = 1,
                    Options = FileOptions.WriteThrough
                }))
                {
                    stream.WriteByte(0x46);
                    stream.Flush(flushToDisk: true);
                }

                canWrite = true;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                errors.Add("Shared DataProtection key-ring directory is not writable.");
            }
            finally
            {
                try
                {
                    File.Delete(probePath);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    errors.Add("DataProtection key-ring write probe could not be removed.");
                    canWrite = false;
                }
            }
        }

        return new DataProtectionKeyRingProbeResult(
            errors.Count == 0,
            applicationName,
            normalizedPath,
            directoryExists,
            canRead,
            canWrite,
            errors);
    }
}
