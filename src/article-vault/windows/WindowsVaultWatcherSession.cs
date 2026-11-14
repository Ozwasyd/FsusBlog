using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>
/// Emits bounded Windows native facts. Construction remains assembly-private until canonical #2109
/// supplies a Windows admitted-root capability; raw handles or structural receipts are not admission.
/// </summary>
public sealed class WindowsVaultWatcherSession : IDisposable
{
    private readonly SafeFileHandle _directory;
    private readonly CancellationTokenSource _stop = new();
    private readonly WindowsVaultFactBuffer _buffer;
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _reader;
    private int _disposed;

    private WindowsVaultWatcherSession(SafeFileHandle ownedDirectory,
        WindowsVaultWatchIdentity identity, WindowsVaultWatcherOptions options,
        Func<WindowsVaultPathAdmission> validateRoot,
        Func<string, WindowsVaultPathAdmission> validatePath)
    {
        _directory = ownedDirectory;
        Identity = identity;
        _buffer = new(identity, options.QueueCapacity);
        _reader = Task.Factory.StartNew(() => Run(options, validateRoot, validatePath),
            _stop.Token, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public WindowsVaultWatchIdentity Identity
    {
        get;
    }

    /// <summary>Remains invalid: raw facts cannot acknowledge or certify a #2112 rescan.</summary>
    public WindowsVaultWatermark Watermark => _buffer.Watermark;

    internal Task NativeStarted => _started.Task;

    /// <summary>Drains at most QueueCapacity facts, preserving native order and explicit loss markers.</summary>
    public IReadOnlyList<WindowsVaultRawFact> ReadAvailable()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        return _buffer.Drain();
    }

    /// <summary>
    /// Internal integration seam, also used by real transport tests. Callers own verified root/path
    /// admission. No production caller exists while the #2109 Windows capability is absent.
    /// </summary>
    internal static WindowsVaultWatcherSession StartNative(SafeFileHandle ownedDirectory,
        WindowsVaultWatchIdentity identity, WindowsVaultWatcherOptions options,
        Func<WindowsVaultPathAdmission> validateRoot,
        Func<string, WindowsVaultPathAdmission> validatePath)
    {
        ArgumentNullException.ThrowIfNull(ownedDirectory);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(validateRoot);
        ArgumentNullException.ThrowIfNull(validatePath);
        options.Validate();
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("windows_vault_requires_real_windows_ntfs");
        }

        if (ownedDirectory.IsInvalid || ownedDirectory.IsClosed || identity.FileSystem != "NTFS")
        {
            throw new InvalidDataException("windows_vault_native_handle_or_semantics_invalid");
        }

        return new(ownedDirectory, identity, options, validateRoot, validatePath);
    }

    /// <summary>Cancels and drains I/O before releasing native memory, handle and owned reader thread.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _stop.Cancel();
        try
        {
            _reader.GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
        finally
        {
            _directory.Dispose();
            _stop.Dispose();
        }
    }

    private void Run(WindowsVaultWatcherOptions options,
        Func<WindowsVaultPathAdmission> validateRoot,
        Func<string, WindowsVaultPathAdmission> validatePath)
    {
        try
        {
            if (!RootStillAdmitted(validateRoot))
            {
                return;
            }

            WindowsDirectoryChangesNative.Observe(_directory, options.NativeBufferBytes, _stop.Token,
                bytes =>
                {
                    if (!RootStillAdmitted(validateRoot))
                    {
                        _stop.Cancel();
                        return;
                    }

                    try
                    {
                        WindowsVaultNotifyDecoder.Decode(bytes, record =>
                            _buffer.Receive(record, validatePath(record.RelativePath)));
                    }
                    catch (InvalidDataException)
                    {
                        _buffer.Failure(WindowsVaultFactClass.WatchInvalidated,
                            "windows_vault_native_record_or_admission_invalid");
                    }

                    if (!RootStillAdmitted(validateRoot))
                    {
                        _stop.Cancel();
                    }
                }, NativeFailure, () => _started.TrySetResult());
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            _buffer.Failure(WindowsVaultFactClass.SecurityBlocked, "windows_vault_admission_unavailable");
        }
        catch (Exception)
        {
            _buffer.Failure(WindowsVaultFactClass.WatchInvalidated, "windows_vault_observer_failed");
        }
        finally
        {
            if (!_started.Task.IsCompleted)
            {
                _started.TrySetException(new IOException("windows_vault_native_watch_start_failed"));
            }
        }
    }

    private bool RootStillAdmitted(Func<WindowsVaultPathAdmission> validateRoot)
    {
        WindowsVaultPathAdmission admission = validateRoot();
        if (admission.Disposition != WindowsVaultPathDisposition.Source)
        {
            _buffer.Failure(WindowsVaultFactClass.RootLost,
                admission.ReasonCode ?? "windows_vault_root_admission_lost");
            return false;
        }

        return true;
    }

    private void NativeFailure(int error)
    {
        WindowsVaultFactClass factClass = error switch
        {
            5 => WindowsVaultFactClass.PermissionBlocked,
            32 => WindowsVaultFactClass.SharingBlocked,
            2 or 3 => WindowsVaultFactClass.RootLost,
            WindowsDirectoryChangesNative.NotifyEnumerationRequired => WindowsVaultFactClass.BufferOverflow,
            _ => WindowsVaultFactClass.WatchInvalidated
        };
        _buffer.Failure(factClass, "windows_vault_native_io_failed", error);
    }
}
