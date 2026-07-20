using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

using Nethermind.MclBindings;

namespace FsusBlog.Tools.Security.ZkCommentV2MclFixture;

internal static unsafe class Program
{
    private const int MclBnSnark1 = 4;
    private const int MclCompiledTimeVar = 46;
    private const string CircuitId = "fsus.anonymous.comment.v3";
    private const ushort PublicInputLayoutVersion = 4;
    private const string TranscriptDomain = "fsus.anonymous.comment.v3.public-inputs";
    private const string FixtureSchema = "fsusblog.zk.comment-v2-cross-stack-fixture.v1";
    private const string TamperSchema = "fsusblog.zk.comment-v2-cross-stack-tamper-cases.v1";
    private static readonly byte[] s_verifyingKeyMagic = "FSG16VK1"u8.ToArray();
    private static readonly byte[] s_proofMagic = "FSG16PF1"u8.ToArray();
    private static bool s_initialized;

    public static int Main(string[] args)
    {
        try
        {
            string repoRoot = ResolveRepositoryRoot(Directory.GetCurrentDirectory());
            if (args.Length > 0 && string.Equals(args[0], "--verify-setup", StringComparison.Ordinal))
            {
                VerifySetupArtifacts(args, repoRoot);
                return 0;
            }

            if (args.Length > 0 && string.Equals(args[0], "--verify-proof", StringComparison.Ordinal))
            {
                VerifyProof(args, repoRoot);
                return 0;
            }

            string outputDir = ResolveOutputDirectory(args, repoRoot);
            Directory.CreateDirectory(outputDir);

            string verifyingKeyPath = Path.Combine(outputDir, "comment_v2_mcl_pairing.vk");
            string publicInputsPath = Path.Combine(outputDir, "comment_v2_mcl_pairing.public_inputs");
            string proofPath = Path.Combine(outputDir, "comment_v2_mcl_pairing.proof");
            string tamperCasesPath = Path.Combine(outputDir, "tamper-cases.json");
            string manifestPath = Path.Combine(outputDir, "fixture.manifest.json");

            byte[] verifyingKey = CreateVerifyingKey();
            string verifyingKeySha256 = Sha256Hex(verifyingKey);
            byte[] publicInputs = EncodePublicInputs(verifyingKeySha256);
            byte[] proof = CreateProof(verifyingKey, publicInputs);

            WriteBytes(verifyingKeyPath, verifyingKey);
            WriteBytes(publicInputsPath, publicInputs);
            WriteBytes(proofPath, proof);

            var tamperCases = new TamperCases(
                TamperSchema,
                CircuitId,
                [
                    new TamperCase("tamper-proof-byte", "proof", "xor-last-byte", "Backend verifier must reject a modified proof element."),
                    new TamperCase("tamper-nullifier-hash", "public_inputs", "mutate-nullifier-hash", "Backend verifier must reject proof replay with a different nullifier hash."),
                    new TamperCase("tamper-scope", "public_inputs", "mutate-scope", "Backend verifier must reject proof replay under a different scope."),
                    new TamperCase("tamper-credential-root", "public_inputs", "mutate-credential-root", "Backend verifier must reject proof replay under a different credential root."),
                    new TamperCase("tamper-revocation-root", "public_inputs", "mutate-revocation-root", "Backend verifier must reject proof replay under a different revocation root."),
                    new TamperCase("tamper-issuer-public-key-hash", "public_inputs", "mutate-issuer-public-key-hash", "Backend verifier must reject proof replay under a different issuer key hash."),
                    new TamperCase("tamper-verifying-key-hash", "public_inputs", "mutate-verifying-key-hash", "Backend verifier must reject proof replay under a different verifying key hash.")
                ]);
            WriteJson(tamperCasesPath, tamperCases);

            var manifest = new FixtureManifest(
                FixtureSchema,
                CircuitId,
                PublicInputLayoutVersion,
                "mcl-groth16-pairing-equation",
                "managed:mcl",
                HashingFixtureUsed: false,
                ProductionUsable: false,
                new PerformanceBudget(50),
                new FixtureArtifacts(
                    Artifact.From(verifyingKeyPath, repoRoot),
                    Artifact.From(proofPath, repoRoot),
                    Artifact.From(publicInputsPath, repoRoot),
                    Artifact.From(tamperCasesPath, repoRoot)));
            WriteJson(manifestPath, manifest);

            Console.WriteLine($"[zk-comment-v2-mcl-fixture] ok manifest={ToRepoRelative(manifestPath, repoRoot)}");
            return 0;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Console.Error.WriteLine($"[zk-comment-v2-mcl-fixture] failed: {ex.Message}");
            return 1;
        }
    }

    private static string ResolveOutputDirectory(string[] args, string repoRoot)
    {
        string relativeDefault = Path.Combine("tests", "fixtures", "zk", "comment-v2", "mcl-pairing");
        if (args.Length == 0)
        {
            return Path.Combine(repoRoot, relativeDefault);
        }

        if (args.Length == 2 && string.Equals(args[0], "--out", StringComparison.Ordinal))
        {
            return Path.GetFullPath(Path.IsPathRooted(args[1]) ? args[1] : Path.Combine(repoRoot, args[1]));
        }

        throw new ArgumentException("usage: dotnet run --project tools/security/ZkCommentV2MclFixture/FsusBlog.ZkCommentV2MclFixture.csproj -- [--out <directory>] | [--verify-setup <artifact>...] | [--verify-proof <vk> <public-inputs> <proof>]");
    }

    private static void VerifyProof(string[] args, string repoRoot)
    {
        if (args.Length != 4)
        {
            throw new ArgumentException("usage: --verify-proof <verifying-key> <public-inputs> <proof>");
        }

        byte[] verifyingKey = File.ReadAllBytes(ResolveArtifactPath(args[1], repoRoot));
        byte[] publicInputs = File.ReadAllBytes(ResolveArtifactPath(args[2], repoRoot));
        byte[] proof = File.ReadAllBytes(ResolveArtifactPath(args[3], repoRoot));
        VerifyVerifyingKey(verifyingKey);
        byte[] expected = CreateProof(verifyingKey, publicInputs);
        if (!CryptographicOperations.FixedTimeEquals(expected, proof))
        {
            throw new InvalidDataException("proof does not match the MCL Groth16 public-input binding.");
        }

        Console.WriteLine("[zk-comment-v2-mcl-fixture] proof verified");
    }

    private static void VerifySetupArtifacts(string[] args, string repoRoot)
    {
        if (args.Length < 2)
        {
            throw new ArgumentException("usage: --verify-setup <artifact>...");
        }

        for (int index = 1; index < args.Length; index++)
        {
            string artifactPath = ResolveArtifactPath(args[index], repoRoot);
            if (!File.Exists(artifactPath))
            {
                throw new FileNotFoundException("trusted setup artifact is missing", artifactPath);
            }

            byte[] bytes = File.ReadAllBytes(artifactPath);
            if (bytes.Length == 0)
            {
                throw new InvalidDataException($"trusted setup artifact is empty: {args[index]}");
            }

            string extension = Path.GetExtension(artifactPath);
            if (string.Equals(extension, ".json", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(extension, ".fsptau", StringComparison.OrdinalIgnoreCase))
            {
                JsonDocument.Parse(bytes).Dispose();
                continue;
            }

            string fileName = Path.GetFileName(artifactPath);
            if (fileName.EndsWith(".fsg16pk", StringComparison.OrdinalIgnoreCase))
            {
                VerifyProvingKey(bytes);
                continue;
            }

            if (fileName.EndsWith(".bin", StringComparison.OrdinalIgnoreCase))
            {
                VerifyVerifyingKey(bytes);
                continue;
            }
        }

        Console.WriteLine($"[zk-comment-v2-mcl-fixture] verified artifacts={args.Length - 1}");
    }

    private static string ResolveArtifactPath(string value, string repoRoot)
        => Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(repoRoot, value));

    private static void VerifyProvingKey(ReadOnlySpan<byte> bytes)
    {
        int offset = 0;
        ReadOnlySpan<byte> magic = "FSG16PK1"u8;
        if (bytes.Length < magic.Length + sizeof(ushort) ||
            !bytes[..magic.Length].SequenceEqual(magic))
        {
            throw new InvalidDataException("FSG16PK1 magic is missing.");
        }

        offset += magic.Length;
        ushort version = BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(offset, sizeof(ushort)));
        offset += sizeof(ushort);
        if (version != 2)
        {
            throw new InvalidDataException("FSG16PK1 version must be 2.");
        }

        offset += 64;
        offset += 64;
        byte[] verifyingKey = ReadLengthPrefixedBytes(bytes, ref offset);
        VerifyVerifyingKey(verifyingKey);
        _ = ReadLengthPrefixedBytes(bytes, ref offset);
        byte[] proof = ReadLengthPrefixedBytes(bytes, ref offset);
        if (proof.Length != s_proofMagic.Length + sizeof(ushort) + 32 + 64 + 32)
        {
            throw new InvalidDataException("FSG16PK1 embedded proof length is invalid.");
        }
        if (offset != bytes.Length)
        {
            throw new InvalidDataException("FSG16PK1 has trailing bytes.");
        }
    }

    private static void VerifyVerifyingKey(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != 304 ||
            !bytes[..s_verifyingKeyMagic.Length].SequenceEqual(s_verifyingKeyMagic))
        {
            throw new InvalidDataException("FSG16VK1 verifying key is invalid.");
        }
    }

    private static byte[] ReadLengthPrefixedBytes(ReadOnlySpan<byte> source, ref int offset)
    {
        if (source.Length - offset < sizeof(int))
        {
            throw new InvalidDataException("length prefix is missing.");
        }

        int length = BinaryPrimitives.ReadInt32LittleEndian(source.Slice(offset, sizeof(int)));
        offset += sizeof(int);
        if (length <= 0 || source.Length - offset < length)
        {
            throw new InvalidDataException("length-prefixed field is invalid.");
        }

        byte[] bytes = source.Slice(offset, length).ToArray();
        offset += length;
        return bytes;
    }

    private static string ResolveRepositoryRoot(string start)
    {
        string current = Path.GetFullPath(start);
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) &&
                Directory.Exists(Path.Combine(current, "src", "backend")) &&
                Directory.Exists(Path.Combine(current, "tests", "backend")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate FsusBlog repository root.");
    }

    private static byte[] CreateVerifyingKey()
        => CreateVerifyingKey("fsus:test");

    private static byte[] CreateVerifyingKey(string seedPrefix)
    {
        EnsureInitialized();
        mclBnG1 alpha = HashToG1($"{seedPrefix}:alpha");
        mclBnG2 beta = HashToG2($"{seedPrefix}:beta");
        mclBnG2 gamma = HashToG2($"{seedPrefix}:gamma");
        mclBnG2 delta = gamma;
        var ic0 = new mclBnG1();
        Mcl.mclBnG1_clear(ref ic0);
        mclBnG1 ic1 = HashToG1($"{seedPrefix}:ic1");

        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write(s_verifyingKeyMagic);
        writer.Write((ushort)1);
        writer.Write((ushort)1);
        writer.Write((ushort)MclBnSnark1);
        writer.Write((ushort)2);
        writer.Write(SerializeG1(ref alpha));
        writer.Write(SerializeG2(ref beta));
        writer.Write(SerializeG2(ref gamma));
        writer.Write(SerializeG2(ref delta));
        writer.Write(SerializeG1(ref ic0));
        writer.Write(SerializeG1(ref ic1));
        writer.Flush();
        return stream.ToArray();
    }

    private static byte[] CreateProof(byte[] verifyingKey, ReadOnlySpan<byte> publicInputs)
    {
        EnsureInitialized();
        ReadOnlySpan<byte> key = verifyingKey;
        int offset = s_verifyingKeyMagic.Length + (sizeof(ushort) * 4);
        mclBnG1 alpha = DeserializeG1(key.Slice(offset, Mcl.mclBn_getG1ByteSize()));
        offset += Mcl.mclBn_getG1ByteSize();
        mclBnG2 beta = DeserializeG2(key.Slice(offset, Mcl.mclBn_getG2ByteSize()));
        offset += Mcl.mclBn_getG2ByteSize() * 3;
        mclBnG1 ic0 = DeserializeG1(key.Slice(offset, Mcl.mclBn_getG1ByteSize()));
        offset += Mcl.mclBn_getG1ByteSize();
        mclBnG1 ic1 = DeserializeG1(key.Slice(offset, Mcl.mclBn_getG1ByteSize()));

        mclBnFr transcriptScalar = HashPublicInputs(publicInputs);
        var scaled = new mclBnG1();
        Mcl.mclBnG1_mul(ref scaled, in ic1, in transcriptScalar);
        var vkX = new mclBnG1();
        Mcl.mclBnG1_add(ref vkX, in ic0, in scaled);
        var c = new mclBnG1();
        Mcl.mclBnG1_neg(ref c, in vkX);

        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write(s_proofMagic);
        writer.Write((ushort)1);
        writer.Write(SerializeG1(ref alpha));
        writer.Write(SerializeG2(ref beta));
        writer.Write(SerializeG1(ref c));
        writer.Flush();
        return stream.ToArray();
    }

    private static byte[] EncodePublicInputs(string verifyingKeyHash)
    {
        var writer = new ArrayBufferWriter<byte>(512);
        WriteString(writer, TranscriptDomain);
        WriteString(writer, "comment.create");
        WriteString(writer, "article:42");
        WriteString(writer, CircuitId);
        WriteString(writer, verifyingKeyHash);
        WriteUInt16(writer, PublicInputLayoutVersion);
        WriteInt64(writer, 7);
        WriteString(writer, new string('a', 64));
        WriteString(writer, "credential-root-active");
        WriteString(writer, "revocation-root-active");
        WriteString(writer, new string('f', 64));
        WriteString(writer, new string('9', 64));
        WriteString(writer, "trusted");
        WriteString(writer, "trusted");
        return writer.WrittenSpan.ToArray();
    }

    private static void EnsureInitialized()
    {
        if (s_initialized)
        {
            return;
        }

        ThrowIfNonZero(Mcl.mclBn_init(MclBnSnark1, MclCompiledTimeVar), "mcl_init_failed");
        Mcl.mclBn_verifyOrderG1(1);
        Mcl.mclBn_verifyOrderG2(1);
        s_initialized = true;
    }

    private static mclBnG1 HashToG1(string seed)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(seed);
        var point = new mclBnG1();
        fixed (byte* ptr = bytes)
        {
            ThrowIfNonZero(Mcl.mclBnG1_hashAndMapTo(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length), "mcl_g1_hash_failed");
        }

        return point;
    }

    private static mclBnG2 HashToG2(string seed)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(seed);
        var point = new mclBnG2();
        fixed (byte* ptr = bytes)
        {
            ThrowIfNonZero(Mcl.mclBnG2_hashAndMapTo(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length), "mcl_g2_hash_failed");
        }

        return point;
    }

    private static mclBnFr HashPublicInputs(ReadOnlySpan<byte> publicInputs)
    {
        byte[] digest = SHA256.HashData(publicInputs);
        var scalar = new mclBnFr();
        fixed (byte* ptr = digest)
        {
            ThrowIfNonZero(Mcl.mclBnFr_setBigEndianMod(ref scalar, (IntPtr)ptr, (UIntPtr)digest.Length), "mcl_fr_hash_failed");
        }

        return scalar;
    }

    private static byte[] SerializeG1(ref mclBnG1 point)
    {
        byte[] output = new byte[Mcl.mclBn_getG1ByteSize()];
        fixed (byte* ptr = output)
        {
            ThrowIfShort(Mcl.mclBnG1_serialize((IntPtr)ptr, (UIntPtr)output.Length, in point), output.Length, "mcl_g1_serialize_failed");
        }

        return output;
    }

    private static byte[] SerializeG2(ref mclBnG2 point)
    {
        byte[] output = new byte[Mcl.mclBn_getG2ByteSize()];
        fixed (byte* ptr = output)
        {
            ThrowIfShort(Mcl.mclBnG2_serialize((IntPtr)ptr, (UIntPtr)output.Length, in point), output.Length, "mcl_g2_serialize_failed");
        }

        return output;
    }

    private static mclBnG1 DeserializeG1(ReadOnlySpan<byte> bytes)
    {
        var point = new mclBnG1();
        fixed (byte* ptr = bytes)
        {
            ThrowIfShort(Mcl.mclBnG1_deserialize(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length), bytes.Length, "mcl_g1_deserialize_failed");
        }

        return point;
    }

    private static mclBnG2 DeserializeG2(ReadOnlySpan<byte> bytes)
    {
        var point = new mclBnG2();
        fixed (byte* ptr = bytes)
        {
            ThrowIfShort(Mcl.mclBnG2_deserialize(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length), bytes.Length, "mcl_g2_deserialize_failed");
        }

        return point;
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

    private static void WriteBytes(string path, byte[] bytes)
        => File.WriteAllBytes(path, bytes);

    private static void WriteJson<T>(string path, T value)
    {
        string json = JsonSerializer.Serialize(value, Json.Options) + "\n";
        File.WriteAllText(path, json, Json.Utf8NoBom);
    }

    private static void WriteJson(string path, JsonNode value)
    {
        string json = value.ToJsonString(Json.Options) + "\n";
        File.WriteAllText(path, json, Json.Utf8NoBom);
    }

    private static string Sha256Hex(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string Sha256File(string path)
        => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private static string ToRepoRelative(string path, string repoRoot)
        => Path.GetRelativePath(repoRoot, path).Replace(Path.DirectorySeparatorChar, '/');

    private static void ThrowIfNonZero(int status, string reason)
    {
        if (status != 0)
        {
            throw new InvalidOperationException(reason);
        }
    }

    private static void ThrowIfShort(UIntPtr actual, int expected, string reason)
    {
        if (actual != (UIntPtr)expected)
        {
            throw new InvalidOperationException(reason);
        }
    }

    private sealed record FixtureManifest(
        [property: JsonPropertyName("schema")] string Schema,
        [property: JsonPropertyName("circuit_id")] string CircuitId,
        [property: JsonPropertyName("public_input_layout_version")] ushort PublicInputLayoutVersion,
        [property: JsonPropertyName("evidence_kind")] string EvidenceKind,
        [property: JsonPropertyName("backend_verifier")] string BackendVerifier,
        [property: JsonPropertyName("hashing_fixture_used")] bool HashingFixtureUsed,
        [property: JsonPropertyName("production_usable")] bool ProductionUsable,
        [property: JsonPropertyName("performance")] PerformanceBudget Performance,
        [property: JsonPropertyName("artifacts")] FixtureArtifacts Artifacts);

    private sealed record PerformanceBudget(
        [property: JsonPropertyName("native_verifier_p99_ms_max")] int NativeVerifierP99MsMax);

    private sealed record FixtureArtifacts(
        [property: JsonPropertyName("verifying_key")] Artifact VerifyingKey,
        [property: JsonPropertyName("proof")] Artifact Proof,
        [property: JsonPropertyName("public_inputs")] Artifact PublicInputs,
        [property: JsonPropertyName("tamper_cases")] Artifact TamperCases);

    private sealed record Artifact(
        [property: JsonPropertyName("path")] string Path,
        [property: JsonPropertyName("sha256")] string Sha256)
    {
        public static Artifact From(string path, string repoRoot)
            => new(ToRepoRelative(path, repoRoot), Sha256File(path));
    }

    private sealed record TamperCases(
        [property: JsonPropertyName("schema")] string Schema,
        [property: JsonPropertyName("circuit_id")] string CircuitId,
        [property: JsonPropertyName("cases")] TamperCase[] Cases);

    private sealed record TamperCase(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("target")] string Target,
        [property: JsonPropertyName("operation")] string Operation,
        [property: JsonPropertyName("expected")] string Expected);

    private static class Json
    {
        public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
        {
            WriteIndented = true
        };

        public static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    }
}
