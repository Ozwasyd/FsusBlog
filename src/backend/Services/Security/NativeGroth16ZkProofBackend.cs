using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Services.Security;

public sealed class NativeGroth16ZkProofBackend : IProductionZkProofBackend, IDisposable
{
    private const string BackendName = ZkProdOptions.NativeGroth16Backend;
    private const string BackendUnavailableReason = "backend_unavailable";
    private readonly NativeGroth16ZkProofBackendOptions _options;
    private readonly INativeGroth16VerifierLibrary _library;
    private readonly ILogger<NativeGroth16ZkProofBackend> _logger;
    private readonly byte[] _verifyingKey;
    private readonly bool _available;
    private readonly string _availabilityReason;

    public NativeGroth16ZkProofBackend(
        IConfiguration configuration,
        ILogger<NativeGroth16ZkProofBackend> logger)
        : this(
            NativeGroth16ZkProofBackendOptions.FromConfiguration(configuration),
            NativeGroth16VerifierLibrary.LoadFromConfiguration(
                NativeGroth16ZkProofBackendOptions.FromConfiguration(configuration)),
            logger)
    {
    }

    internal NativeGroth16ZkProofBackend(
        NativeGroth16ZkProofBackendOptions options,
        INativeGroth16VerifierLibrary library,
        ILogger<NativeGroth16ZkProofBackend> logger)
    {
        _options = options;
        _library = library;
        _logger = logger;
        (_verifyingKey, _availabilityReason) = LoadVerifyingKey(options);
        _available = _library.IsLoaded &&
            _verifyingKey.Length > 0 &&
            string.Equals(_availabilityReason, "ready", StringComparison.Ordinal);
    }

    public bool IsAvailable(string backendName)
        => _available && string.Equals(backendName, BackendName, StringComparison.Ordinal);

    public Task<ProductionZkProofBackendResult> VerifyAsync(
        ProductionZkProofBackendRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!IsAvailable(BackendName))
        {
            return Task.FromResult(ProductionZkProofBackendResult.Rejected(BackendUnavailableReason));
        }

        return Task.Run(() => VerifyCore(request, cancellationToken), cancellationToken);
    }

    public void Dispose()
        => _library.Dispose();

    private ProductionZkProofBackendResult VerifyCore(
        ProductionZkProofBackendRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            ReadOnlyMemory<byte> publicInputs = NativeGroth16PublicInputCodec.Encode(request);
            NativeGroth16VerifierCallResult result = _library.Verify(
                _verifyingKey,
                publicInputs.Span,
                request.Proof.Span);

            return result.Verified
                ? ProductionZkProofBackendResult.Accepted()
                : ProductionZkProofBackendResult.Rejected(result.Reason);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            _logger.LogWarning("Native Groth16 verifier failed closed for backend {Backend}.", BackendName);
            return ProductionZkProofBackendResult.Rejected("native_error");
        }
    }

    private static (byte[] Bytes, string Reason) LoadVerifyingKey(NativeGroth16ZkProofBackendOptions options)
    {
        if (options.VerifyingKeyPath.Length == 0)
        {
            return ([], "verifying_key_path_missing");
        }

        if (!File.Exists(options.VerifyingKeyPath))
        {
            return ([], "verifying_key_missing");
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(options.VerifyingKeyPath);
        }
        catch
        {
            return ([], "verifying_key_unreadable");
        }

        if (bytes.Length == 0)
        {
            return ([], "verifying_key_empty");
        }

        string actualHash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (!string.Equals(actualHash, options.VerifyingKeySha256, StringComparison.Ordinal))
        {
            return ([], "verifying_key_hash_mismatch");
        }

        return (bytes, "ready");
    }
}

internal sealed record NativeGroth16ZkProofBackendOptions(
    string LibraryPath,
    string VerifyingKeyPath,
    string VerifyingKeySha256,
    string EntryPoint)
{
    public const string SectionName = "AnonymousIdentity:ZkVerifier:NativeGroth16";
    private const string DefaultEntryPoint = "fsus_zk_groth16_verify";
    private const string NativeLibraryEnvironmentVariable = "FSUSBLOG_ZK_GROTH16_NATIVE_LIBRARY";
    private const string VerifyingKeyEnvironmentVariable = "FSUSBLOG_ZK_GROTH16_VERIFYING_KEY";

    public static NativeGroth16ZkProofBackendOptions FromConfiguration(IConfiguration configuration)
    {
        string libraryPath = NormalizePath(
            configuration[$"{SectionName}:LibraryPath"],
            Environment.GetEnvironmentVariable(NativeLibraryEnvironmentVariable),
            DefaultLibraryPath());
        string verifyingKeyPath = NormalizePath(
            configuration[$"{SectionName}:VerifyingKeyPath"],
            Environment.GetEnvironmentVariable(VerifyingKeyEnvironmentVariable),
            DefaultVerifyingKeyPath());
        string verifyingKeyHash = NormalizeSha256(
            configuration[$"{SectionName}:VerifyingKeySha256"] ??
            configuration[$"{SectionName}:VerifyingKeyHash"] ??
            configuration["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"]);
        string entryPoint = NormalizeToken(configuration[$"{SectionName}:EntryPoint"], DefaultEntryPoint, 128);

        return new NativeGroth16ZkProofBackendOptions(
            libraryPath,
            verifyingKeyPath,
            verifyingKeyHash,
            entryPoint);
    }

    private static string DefaultLibraryPath()
    {
        string fileName = OperatingSystem.IsWindows()
            ? "fsus_zk_groth16.dll"
            : OperatingSystem.IsMacOS()
                ? "libfsus_zk_groth16.dylib"
                : "libfsus_zk_groth16.so";

        return Path.Combine(AppContext.BaseDirectory, "native", "zk", fileName);
    }

    private static string DefaultVerifyingKeyPath()
        => Path.Combine(AppContext.BaseDirectory, "native", "zk", "comment.v1.vk");

    private static string NormalizePath(string? configured, string? environment, string fallback)
    {
        string value = !string.IsNullOrWhiteSpace(configured)
            ? configured.Trim()
            : !string.IsNullOrWhiteSpace(environment)
                ? environment.Trim()
                : fallback;

        return value.Length <= 4096 ? value : value[..4096];
    }

    private static string NormalizeSha256(string? value)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        if (normalized.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized["sha256:".Length..];
        }

        return normalized.Length == 64 ? normalized.ToLowerInvariant() : string.Empty;
    }

    private static string NormalizeToken(string? value, string fallback, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }
}

internal readonly record struct NativeGroth16VerifierCallResult(bool Verified, string Reason)
{
    public static NativeGroth16VerifierCallResult Accepted()
        => new(true, "verified");

    public static NativeGroth16VerifierCallResult Rejected(string? reason = null)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "invalid" : reason);
}

internal interface INativeGroth16VerifierLibrary : IDisposable
{
    bool IsLoaded { get; }

    NativeGroth16VerifierCallResult Verify(
        ReadOnlySpan<byte> verifyingKey,
        ReadOnlySpan<byte> publicInputs,
        ReadOnlySpan<byte> proof);
}

internal sealed unsafe class NativeGroth16VerifierLibrary : INativeGroth16VerifierLibrary
{
    private readonly IntPtr _libraryHandle;
    private readonly delegate* unmanaged[Cdecl]<byte*, nuint, byte*, nuint, byte*, nuint, int> _verify;

    private NativeGroth16VerifierLibrary(IntPtr libraryHandle, IntPtr verifyExport)
    {
        _libraryHandle = libraryHandle;
        _verify = (delegate* unmanaged[Cdecl]<byte*, nuint, byte*, nuint, byte*, nuint, int>)verifyExport;
    }

    public bool IsLoaded => _libraryHandle != IntPtr.Zero;

    public static INativeGroth16VerifierLibrary LoadFromConfiguration(NativeGroth16ZkProofBackendOptions options)
    {
        if (options.LibraryPath.Length == 0)
        {
            return UnavailableNativeGroth16VerifierLibrary.Instance;
        }

        try
        {
            IntPtr handle = NativeLibrary.Load(options.LibraryPath);
            IntPtr export = NativeLibrary.GetExport(handle, options.EntryPoint);
            return new NativeGroth16VerifierLibrary(handle, export);
        }
        catch
        {
            return UnavailableNativeGroth16VerifierLibrary.Instance;
        }
    }

    public NativeGroth16VerifierCallResult Verify(
        ReadOnlySpan<byte> verifyingKey,
        ReadOnlySpan<byte> publicInputs,
        ReadOnlySpan<byte> proof)
    {
        fixed (byte* verifyingKeyPtr = verifyingKey)
        fixed (byte* publicInputsPtr = publicInputs)
        fixed (byte* proofPtr = proof)
        {
            int status = _verify(
                verifyingKeyPtr,
                (nuint)verifyingKey.Length,
                publicInputsPtr,
                (nuint)publicInputs.Length,
                proofPtr,
                (nuint)proof.Length);

            return status == 1
                ? NativeGroth16VerifierCallResult.Accepted()
                : NativeGroth16VerifierCallResult.Rejected(status == 0 ? "invalid_proof" : "native_error");
        }
    }

    public void Dispose()
    {
        if (_libraryHandle != IntPtr.Zero)
        {
            NativeLibrary.Free(_libraryHandle);
        }
    }
}

internal sealed class UnavailableNativeGroth16VerifierLibrary : INativeGroth16VerifierLibrary
{
    public static UnavailableNativeGroth16VerifierLibrary Instance { get; } = new();

    private UnavailableNativeGroth16VerifierLibrary()
    {
    }

    public bool IsLoaded => false;

    public NativeGroth16VerifierCallResult Verify(
        ReadOnlySpan<byte> verifyingKey,
        ReadOnlySpan<byte> publicInputs,
        ReadOnlySpan<byte> proof)
        => NativeGroth16VerifierCallResult.Rejected("native_library_unavailable");

    public void Dispose()
    {
    }
}

internal static class NativeGroth16PublicInputCodec
{
    private const string TranscriptDomain = "fsus.anonymous.comment.v1.public-inputs";

    public static ReadOnlyMemory<byte> Encode(ProductionZkProofBackendRequest request)
    {
        var writer = new ArrayBufferWriter<byte>(512);
        WriteString(writer, TranscriptDomain);
        WriteString(writer, request.ActionContext);
        WriteString(writer, request.Scope);
        WriteString(writer, request.CircuitId);
        WriteString(writer, request.VerifyingKeyHash);
        WriteUInt16(writer, request.PublicInputLayoutVersion);
        WriteInt64(writer, request.CredentialEpoch);
        WriteString(writer, request.NullifierHash);
        WriteString(writer, request.CredentialCommitment);
        WriteString(writer, request.CredentialRoot);
        WriteString(writer, request.RevocationRoot);
        WriteString(writer, request.IssuerPublicKeyHash);
        WriteString(writer, request.ReputationBucket ?? string.Empty);
        return writer.WrittenMemory.ToArray();
    }

    private static void WriteString(IBufferWriter<byte> writer, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        WriteInt32(writer, bytes.Length);
        writer.Write(bytes);
    }

    private static void WriteInt32(IBufferWriter<byte> writer, int value)
    {
        Span<byte> span = writer.GetSpan(sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(span, value);
        writer.Advance(sizeof(int));
    }

    private static void WriteUInt16(IBufferWriter<byte> writer, ushort value)
    {
        Span<byte> span = writer.GetSpan(sizeof(ushort));
        BinaryPrimitives.WriteUInt16LittleEndian(span, value);
        writer.Advance(sizeof(ushort));
    }

    private static void WriteInt64(IBufferWriter<byte> writer, long value)
    {
        Span<byte> span = writer.GetSpan(sizeof(long));
        BinaryPrimitives.WriteInt64LittleEndian(span, value);
        writer.Advance(sizeof(long));
    }
}
