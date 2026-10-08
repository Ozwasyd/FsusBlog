using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

using Nethermind.MclBindings;

namespace FsusBlog.Server.Services.Security;

public sealed class NativeGroth16ZkProofBackend : IProductionZkProofBackend, IDisposable
{
    private const string BackendName = ZkVerifierOptions.NativeGroth16Backend;
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
    public const string ManagedMclLibraryPath = "managed:mcl";
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
            ZkVerifierOptions.FromConfiguration(configuration).VerifyingKeyHash);
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
        => Path.Combine(AppContext.BaseDirectory, "native", "zk", "comment.v5.vk");

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
    bool IsLoaded
    {
        get;
    }

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

        if (string.Equals(options.LibraryPath, NativeGroth16ZkProofBackendOptions.ManagedMclLibraryPath, StringComparison.Ordinal))
        {
            return MclGroth16VerifierLibrary.Create();
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

internal sealed unsafe class MclGroth16VerifierLibrary : INativeGroth16VerifierLibrary
{
    private const int MclBnSnark1 = 4;
    private const int MclCompiledTimeVar = 46;
    private const ushort FormatVersion = 1;
    private const ushort PublicInputHashBindingMode = 1;
    private static readonly byte[] s_verifyingKeyMagic = "FSG16VK1"u8.ToArray();
    private static readonly byte[] s_proofMagic = "FSG16PF1"u8.ToArray();
    private static readonly object s_initializationLock = new();
    private static bool s_initialized;
    private static bool s_available;

    private MclGroth16VerifierLibrary(bool available)
    {
        IsLoaded = available;
    }

    public bool IsLoaded
    {
        get;
    }

    public static MclGroth16VerifierLibrary Create()
        => new(EnsureInitialized());

    public NativeGroth16VerifierCallResult Verify(
        ReadOnlySpan<byte> verifyingKey,
        ReadOnlySpan<byte> publicInputs,
        ReadOnlySpan<byte> proof)
    {
        if (!IsLoaded)
        {
            return NativeGroth16VerifierCallResult.Rejected("mcl_unavailable");
        }

        try
        {
            if (!TryReadVerifyingKey(
                    verifyingKey,
                    out mclBnG1 alphaG1,
                    out mclBnG2 betaG2,
                    out mclBnG2 gammaG2,
                    out mclBnG2 deltaG2,
                    out mclBnG1 inputConstant,
                    out mclBnG1 inputHashGenerator) ||
                !TryReadProof(
                    proof,
                    out mclBnG1 proofA,
                    out mclBnG2 proofB,
                    out mclBnG1 proofC))
            {
                return NativeGroth16VerifierCallResult.Rejected("invalid_artifact");
            }

            mclBnFr transcriptScalar = HashPublicInputs(publicInputs);
            var scaledInput = new mclBnG1();
            Mcl.mclBnG1_mul(ref scaledInput, in inputHashGenerator, in transcriptScalar);
            var publicInputCommitment = new mclBnG1();
            Mcl.mclBnG1_add(ref publicInputCommitment, in inputConstant, in scaledInput);

            var leftLine = new mclBnGT();
            Mcl.mclBn_millerLoop(ref leftLine, in proofA, in proofB);

            var rightLine = new mclBnGT();
            Mcl.mclBn_millerLoop(ref rightLine, in alphaG1, in betaG2);
            var termLine = new mclBnGT();
            Mcl.mclBn_millerLoop(ref termLine, in publicInputCommitment, in gammaG2);
            Mcl.mclBnGT_mul(ref rightLine, in rightLine, in termLine);
            Mcl.mclBn_millerLoop(ref termLine, in proofC, in deltaG2);
            Mcl.mclBnGT_mul(ref rightLine, in rightLine, in termLine);

            var left = new mclBnGT();
            Mcl.mclBn_finalExp(ref left, in leftLine);
            var right = new mclBnGT();
            Mcl.mclBn_finalExp(ref right, in rightLine);

            return Mcl.mclBnGT_isEqual(in left, in right) == 1
                ? NativeGroth16VerifierCallResult.Accepted()
                : NativeGroth16VerifierCallResult.Rejected("invalid_proof");
        }
        catch
        {
            return NativeGroth16VerifierCallResult.Rejected("native_error");
        }
    }

    public void Dispose()
    {
    }

    private static bool EnsureInitialized()
    {
        if (s_initialized)
        {
            return s_available;
        }

        lock (s_initializationLock)
        {
            if (s_initialized)
            {
                return s_available;
            }

            s_available = Mcl.mclBn_init(MclBnSnark1, MclCompiledTimeVar) == 0;
            if (s_available)
            {
                Mcl.mclBn_verifyOrderG1(1);
                Mcl.mclBn_verifyOrderG2(1);
            }

            s_initialized = true;
            return s_available;
        }
    }

    private static bool TryReadVerifyingKey(
        ReadOnlySpan<byte> bytes,
        out mclBnG1 alphaG1,
        out mclBnG2 betaG2,
        out mclBnG2 gammaG2,
        out mclBnG2 deltaG2,
        out mclBnG1 inputConstant,
        out mclBnG1 inputHashGenerator)
    {
        alphaG1 = default;
        betaG2 = default;
        gammaG2 = default;
        deltaG2 = default;
        inputConstant = default;
        inputHashGenerator = default;
        int offset = 0;
        if (!TryReadMagic(bytes, ref offset, s_verifyingKeyMagic) ||
            !TryReadUInt16(bytes, ref offset, out ushort version) ||
            !TryReadUInt16(bytes, ref offset, out ushort bindingMode) ||
            !TryReadUInt16(bytes, ref offset, out ushort curve) ||
            !TryReadUInt16(bytes, ref offset, out ushort inputCommitmentCount) ||
            version != FormatVersion ||
            bindingMode != PublicInputHashBindingMode ||
            curve != MclBnSnark1 ||
            inputCommitmentCount != 2)
        {
            return false;
        }

        if (!TryReadRequiredG1(bytes, offset, out alphaG1, out offset, allowZero: false))
        {
            return false;
        }
        if (!TryReadRequiredG2(bytes, offset, out betaG2, out offset, allowZero: false))
        {
            return false;
        }
        if (!TryReadRequiredG2(bytes, offset, out gammaG2, out offset, allowZero: false))
        {
            return false;
        }
        if (!TryReadRequiredG2(bytes, offset, out deltaG2, out offset, allowZero: false))
        {
            return false;
        }
        if (!TryReadRequiredG1(bytes, offset, out inputConstant, out offset, allowZero: true))
        {
            return false;
        }
        if (!TryReadRequiredG1(bytes, offset, out inputHashGenerator, out offset, allowZero: false))
        {
            return false;
        }

        return offset == bytes.Length;
    }

    private static bool TryReadProof(
        ReadOnlySpan<byte> bytes,
        out mclBnG1 a,
        out mclBnG2 b,
        out mclBnG1 c)
    {
        a = default;
        b = default;
        c = default;
        int offset = 0;
        if (!TryReadMagic(bytes, ref offset, s_proofMagic) ||
            !TryReadUInt16(bytes, ref offset, out ushort version) ||
            version != FormatVersion)
        {
            return false;
        }

        if (!TryReadRequiredG1(bytes, offset, out a, out offset, allowZero: false))
        {
            return false;
        }
        if (!TryReadRequiredG2(bytes, offset, out b, out offset, allowZero: false))
        {
            return false;
        }
        if (!TryReadRequiredG1(bytes, offset, out c, out offset, allowZero: true))
        {
            return false;
        }

        return offset == bytes.Length;
    }

    private static bool TryReadMagic(ReadOnlySpan<byte> source, ref int offset, ReadOnlySpan<byte> magic)
    {
        if (source.Length - offset < magic.Length ||
            !source.Slice(offset, magic.Length).SequenceEqual(magic))
        {
            return false;
        }

        offset += magic.Length;
        return true;
    }

    private static bool TryReadUInt16(ReadOnlySpan<byte> source, ref int offset, out ushort value)
    {
        value = 0;
        if (source.Length - offset < sizeof(ushort))
        {
            return false;
        }

        value = BinaryPrimitives.ReadUInt16LittleEndian(source.Slice(offset, sizeof(ushort)));
        offset += sizeof(ushort);
        return true;
    }

    private static bool TryReadRequiredG1(
        ReadOnlySpan<byte> source,
        int offset,
        out mclBnG1 value,
        out int nextOffset,
        bool allowZero)
    {
        value = default;
        nextOffset = offset;
        int length = Mcl.mclBn_getG1ByteSize();
        if (source.Length - offset < length)
        {
            return false;
        }

        ReadOnlySpan<byte> encoded = source.Slice(offset, length);
        nextOffset = offset + length;
        fixed (byte* ptr = encoded)
        {
            if (Mcl.mclBnG1_deserialize(ref value, (IntPtr)ptr, (UIntPtr)encoded.Length) != (UIntPtr)encoded.Length)
            {
                return false;
            }
        }

        Span<byte> canonical = stackalloc byte[length];
        fixed (byte* ptr = canonical)
        {
            if (Mcl.mclBnG1_serialize((IntPtr)ptr, (UIntPtr)canonical.Length, in value) != (UIntPtr)canonical.Length)
            {
                return false;
            }
        }
        if (!CryptographicOperations.FixedTimeEquals(encoded, canonical))
        {
            return false;
        }

        return Mcl.mclBnG1_isValid(in value) == 1 &&
            Mcl.mclBnG1_isValidOrder(in value) == 1 &&
            (allowZero || Mcl.mclBnG1_isZero(in value) == 0);
    }

    private static bool TryReadRequiredG2(
        ReadOnlySpan<byte> source,
        int offset,
        out mclBnG2 value,
        out int nextOffset,
        bool allowZero)
    {
        value = default;
        nextOffset = offset;
        int length = Mcl.mclBn_getG2ByteSize();
        if (source.Length - offset < length)
        {
            return false;
        }

        ReadOnlySpan<byte> encoded = source.Slice(offset, length);
        nextOffset = offset + length;
        fixed (byte* ptr = encoded)
        {
            if (Mcl.mclBnG2_deserialize(ref value, (IntPtr)ptr, (UIntPtr)encoded.Length) != (UIntPtr)encoded.Length)
            {
                return false;
            }
        }

        Span<byte> canonical = stackalloc byte[length];
        fixed (byte* ptr = canonical)
        {
            if (Mcl.mclBnG2_serialize((IntPtr)ptr, (UIntPtr)canonical.Length, in value) != (UIntPtr)canonical.Length)
            {
                return false;
            }
        }
        if (!CryptographicOperations.FixedTimeEquals(encoded, canonical))
        {
            return false;
        }

        return Mcl.mclBnG2_isValid(in value) == 1 &&
            Mcl.mclBnG2_isValidOrder(in value) == 1 &&
            (allowZero || Mcl.mclBnG2_isZero(in value) == 0);
    }

    private static mclBnFr HashPublicInputs(ReadOnlySpan<byte> publicInputs)
    {
        byte[] digest = SHA256.HashData(publicInputs);
        var scalar = new mclBnFr();
        fixed (byte* ptr = digest)
        {
            if (Mcl.mclBnFr_setBigEndianMod(ref scalar, (IntPtr)ptr, (UIntPtr)digest.Length) != 0)
            {
                throw new InvalidOperationException("mcl_fr_hash_failed");
            }
        }

        return scalar;
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
    private const string TranscriptDomain = "fsus.anonymous.comment.v5.public-inputs";

    public static ReadOnlyMemory<byte> Encode(ProductionZkProofBackendRequest request)
    {
        int length = checked(
            EncodedStringSize(TranscriptDomain)
            + EncodedStringSize(request.ActionContext)
            + EncodedStringSize(request.Scope)
            + EncodedStringSize(request.CircuitId)
            + EncodedStringSize(request.VerifyingKeyHash)
            + sizeof(ushort)
            + EncodedStringSize(request.NullifierHash)
            + EncodedStringSize(request.CredentialRoot)
            + EncodedStringSize(request.RevocationRoot)
            + EncodedStringSize(request.IssuerPublicKeyHash)
            + EncodedStringSize(request.PolicyHash)
            + 3
            + EncodedStringSize(request.RateClass));
        byte[] encoded = GC.AllocateUninitializedArray<byte>(length);
        Span<byte> destination = encoded;
        int offset = 0;
        WriteString(destination, ref offset, TranscriptDomain);
        WriteString(destination, ref offset, request.ActionContext);
        WriteString(destination, ref offset, request.Scope);
        WriteString(destination, ref offset, request.CircuitId);
        WriteString(destination, ref offset, request.VerifyingKeyHash);
        WriteUInt16(destination, ref offset, request.PublicInputLayoutVersion);
        WriteString(destination, ref offset, request.NullifierHash);
        WriteString(destination, ref offset, request.CredentialRoot);
        WriteString(destination, ref offset, request.RevocationRoot);
        WriteString(destination, ref offset, request.IssuerPublicKeyHash);
        WriteString(destination, ref offset, request.PolicyHash);
        destination[offset++] = request.IsEligible ? (byte)1 : (byte)0;
        destination[offset++] = request.MayComment ? (byte)1 : (byte)0;
        WriteString(destination, ref offset, request.RateClass);
        destination[offset++] = request.RequiresModeration ? (byte)1 : (byte)0;
        return encoded;
    }

    private static int EncodedStringSize(string value)
        => checked(sizeof(int) + Encoding.UTF8.GetByteCount(value));

    private static void WriteString(Span<byte> destination, ref int offset, string value)
    {
        int byteCount = Encoding.UTF8.GetByteCount(value);
        WriteInt32(destination, ref offset, byteCount);
        offset += Encoding.UTF8.GetBytes(value, destination[offset..(offset + byteCount)]);
    }

    private static void WriteInt32(Span<byte> destination, ref int offset, int value)
    {
        BinaryPrimitives.WriteInt32LittleEndian(destination[offset..], value);
        offset += sizeof(int);
    }

    private static void WriteUInt16(Span<byte> destination, ref int offset, ushort value)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(destination[offset..], value);
        offset += sizeof(ushort);
    }

}
