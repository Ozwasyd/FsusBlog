using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using FsusBlog.V2.Core.Authentication;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyTotpRing = "FSUSBLOG_LEGACY_TOTP_RING";
    private const string LegacyTotpCert = "FSUSBLOG_LEGACY_TOTP_CERT";
    private const string LegacyTotpCode = "FSUSBLOG_LEGACY_TOTP_PROOF";
    private const string TargetTotpKey = "FSUSBLOG_TOTP_KEY_HEX";
    private sealed record LegacyMfaSource(string Ciphertext, DateTimeOffset Verified, long LastStep, string Digest);
    private sealed record LegacyMfaApproval(string SourceSha256, string RingSha256, string CertificateSha256,
        string TargetKeySha256, string RecoveryCodes);

    private sealed class LegacyMfaProof(byte[] seed, byte[] key, long step) : IDisposable
    {
        internal long Step => step;
        internal TotpSecret Secrets { get; } = new(key);
        internal byte[] Seed => seed;

        public void Dispose()
        {
            CryptographicOperations.ZeroMemory(seed);
            CryptographicOperations.ZeroMemory(key);
        }
    }

    private sealed class LegacyMfaKeyRepository(XElement[] elements) : IXmlRepository
    {
        public IReadOnlyCollection<XElement> GetAllElements() => elements;
        public void StoreElement(XElement element, string friendlyName) =>
            throw new InvalidOperationException("Legacy MFA key custody is read-only.");
    }

    private static async Task<LegacyMfaSource> ReadLegacyMfaAsync(LegacySource source, NpgsqlTransaction tx, int account, CancellationToken ct)
    {
        var table = source.Table(LegacyPasskeyTable(await ReadLegacyCatalogAsync(source, tx, ct), "user_mfa_profile"));
        await using var query = new NpgsqlCommand($"""
            SELECT id,mfa_secret_encrypted,mfa_verified_at,last_totp_step,last_totp_used_at_utc,hash_version,updated_at_utc,
                encode(sha256(convert_to(mfa_recovery_codes_hash,'UTF8')),'hex')
            FROM {table} t
            WHERE user_id=$1 AND t.tableoid=to_regclass($2) AND mfa_pending_secret_encrypted IS NULL AND mfa_pending_created_at IS NULL
                AND octet_length(mfa_secret_encrypted) BETWEEN 1 AND 4096
                AND (mfa_recovery_codes_hash IS NULL OR octet_length(mfa_recovery_codes_hash)<=16384)
                AND (SELECT count(*) FROM {table} profile WHERE profile.user_id=$1)=1
            """, tx.Connection, tx);
        query.Parameters.AddWithValue(account);
        query.Parameters.AddWithValue(table);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || AssetInteger(row.GetValue(0)) <= 0 ||
            IdentityTime(row, 2) is not { } verified || verified <= DateTimeOffset.UnixEpoch ||
            row.IsDBNull(3) || AssetInteger(row.GetValue(3)) < 0 ||
            IdentityTime(row, 4) is not { } used || used < verified ||
            AssetInteger(row.GetValue(5)) is < 0 or > 3 || IdentityTime(row, 6) is not { } updated || updated < verified)
            throw new InvalidOperationException("Live continuity requires one compatible settled legacy MFA profile.");
        var id = AssetInteger(row.GetValue(0));
        var ciphertext = row.GetString(1);
        var last = AssetInteger(row.GetValue(3));
        var version = AssetInteger(row.GetValue(5));
        var recoveryDigest = IdentityText(row, 7);
        if (Math.Abs(last - used.ToUnixTimeSeconds() / Totp.StepSeconds) > 1 || used > DateTimeOffset.UtcNow.AddSeconds(30) ||
            await row.ReadAsync(ct))
            throw new InvalidOperationException("The legacy MFA replay floor or timestamps are inconsistent.");
        return new(ciphertext, verified, last, DigestMediaDocument(new { id, account, ciphertext, verified, last, used, version, updated, recoveryDigest }));
    }

    private static LegacyMfaApproval ObserveLegacyMfaApproval(LegacyMfaSource source)
    {
        var key = ReadTargetTotpKey();
        try { return new(source.Digest, LegacyMfaPin(LegacyTotpRing), LegacyMfaPin(LegacyTotpCert), Convert.ToHexStringLower(SHA256.HashData(key)), "retire-regenerate"); }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    private static string LegacyMfaPin(string name) =>
        Environment.GetEnvironmentVariable(name + "_SHA256") is { } seal && IsSha256(seal) ?
            seal : throw new InvalidOperationException($"Set a separately reviewed digest for {name}.");

    private static Task<byte[]> ReadLegacyMfaInputAsync(string name, string seal, int limit, CancellationToken ct) =>
        ReadLegacyPasskeyInputAsync(Environment.GetEnvironmentVariable(name) ??
            throw new InvalidOperationException($"Set the private input for {name}."), seal, limit, ct);

    private static byte[] ReadTargetTotpKey() =>
        Environment.GetEnvironmentVariable(TargetTotpKey) is { Length: 64 } hex && hex.All(char.IsAsciiHexDigit) ?
            Convert.FromHexString(hex) : throw new InvalidOperationException("A configured V2 TOTP sealing key is required.");

    private static async Task<byte[]> OpenOldLegacyMfaAsync(string encoded, LegacyMfaApproval approval, CancellationToken ct)
    {
        var ring = await ReadLegacyMfaInputAsync(LegacyTotpRing, approval.RingSha256, 2 * 1024 * 1024, ct);
        byte[]? pkcs12 = null;
        try
        {
            pkcs12 = await ReadLegacyMfaInputAsync(LegacyTotpCert, approval.CertificateSha256, 65536, ct);
            var entries = JsonSerializer.Deserialize<string[]>(ring, OwnerMapJson);
            if (entries is not { Length: >= 1 and <= 64 }) throw new FormatException();
            var elements = new List<XElement>(entries.Length);
            foreach (var entry in entries)
            {
                if (entry is null) throw new FormatException();
                using var text = new StringReader(entry);
                using var xml = XmlReader.Create(text, new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1024 * 1024
                });
                var root = XDocument.Load(xml).Root;
                if (root is null || (root.Name != "revocation" && (root.Name != "key" ||
                        !root.Descendants().Any(node => node.Name.LocalName == "encryptedSecret") ||
                        root.Descendants().Any(node => node.Name.LocalName == "masterKey"))))
                    throw new FormatException();
                elements.Add(root);
            }
            using var cert = X509CertificateLoader.LoadPkcs12(pkcs12, Environment.GetEnvironmentVariable(LegacyTotpCert + "_PASSWORD"),
                OperatingSystem.IsMacOS() ? X509KeyStorageFlags.DefaultKeySet : X509KeyStorageFlags.EphemeralKeySet);
            using var rsa = cert.GetRSAPrivateKey();
            if (rsa is null) throw new FormatException();
            var services = new ServiceCollection();
            services.AddDataProtection().SetApplicationName("FsusBlog").DisableAutomaticKeyGeneration().UnprotectKeysWithAnyCertificate(cert);
            services.Configure<KeyManagementOptions>(options => options.XmlRepository = new LegacyMfaKeyRepository(elements.ToArray()));
            using var provider = services.BuildServiceProvider();
            var plain = provider.GetRequiredService<IDataProtectionProvider>().CreateProtector("fsusblog.auth.totp.v1")
                .Unprotect(ReadCanonicalBase64Url(encoded, 2, 4096));
            try { return DecodeLegacyMfaSeed(plain); }
            finally { CryptographicOperations.ZeroMemory(plain); }
        }
        catch (Exception error) when (error is CryptographicException or XmlException or FormatException or JsonException)
        {
            throw new InvalidOperationException("The reviewed original key ring cannot authenticate and open the legacy TOTP profile.");
        }
        finally
        {
            if (pkcs12 is not null) CryptographicOperations.ZeroMemory(pkcs12);
            CryptographicOperations.ZeroMemory(ring);
        }
    }

    private static byte[] DecodeLegacyMfaSeed(byte[] base32)
    {
        if (base32.Length != 32 || !base32.All(value => value is >= (byte)'A' and <= (byte)'Z' or >= (byte)'2' and <= (byte)'7'))
            throw new FormatException();
        var seed = new byte[Totp.SecretBytes];
        int bits = 0, value = 0, offset = 0;
        foreach (var symbol in base32)
        {
            value = (value << 5) | (symbol >= 'A' ? symbol - 'A' : symbol - '2' + 26);
            bits += 5;
            if (bits < 8) continue;
            bits -= 8;
            seed[offset++] = (byte)(value >> bits);
        }
        return seed;
    }

    private static async Task<LegacyMfaProof> ProveLegacyMfaAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid user,
        LegacyMfaSource source, LegacyMfaApproval approval, bool pristine, CancellationToken ct)
    {
        var code = await ReadLegacyMfaInputAsync(LegacyTotpCode, LegacyMfaPin(LegacyTotpCode), 6, ct);
        byte[]? seed = null, key = null;
        try
        {
            if (code.Length != 6 || !code.All(value => value is >= (byte)'0' and <= (byte)'9'))
                throw new InvalidOperationException("Provide a private six-digit legacy TOTP proof.");
            key = ReadTargetTotpKey();
            if (Convert.ToHexStringLower(SHA256.HashData(key)) != approval.TargetKeySha256) throw new InvalidOperationException("The reviewed V2 TOTP sealing key has changed.");
            seed = await OpenOldLegacyMfaAsync(source.Ciphertext, approval, ct);
            var now = DateTimeOffset.UtcNow;
            long? priorReceipt = null;
            if (!pristine)
            {
                await using var receipt = new NpgsqlCommand("SELECT last_step FROM public.mfa_totp WHERE user_id=$1", db, tx);
                receipt.Parameters.AddWithValue(user);
                if (await receipt.ExecuteScalarAsync(ct) is not long step || step <= source.LastStep ||
                    step > now.ToUnixTimeSeconds() / Totp.StepSeconds + 1)
                    throw new InvalidOperationException("The imported MFA receipt is missing or outside its replay bounds.");
                priorReceipt = step;
                now = DateTimeOffset.FromUnixTimeSeconds(step * Totp.StepSeconds);
            }
            var matched = Totp.Match(seed, Encoding.ASCII.GetString(code), now, source.LastStep);
            if (!matched.HasValue || priorReceipt.HasValue && matched != priorReceipt)
                throw new InvalidOperationException("Fresh legacy TOTP continuity could not be verified.");
            var proof = new LegacyMfaProof(seed, key, matched.Value);
            (seed, key) = (null, null);
            return proof;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(code);
            if (seed is not null) CryptographicOperations.ZeroMemory(seed);
            if (key is not null) CryptographicOperations.ZeroMemory(key);
        }
    }

    private static async Task WriteLegacyMfaAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        LegacyMfaSource source, LegacyMfaProof proof, CancellationToken ct)
    {
        await using var write = new NpgsqlCommand("""
            INSERT INTO public.mfa_totp (user_id,sealed_seed,last_step,verified_at,retry_after,failed_count)
            VALUES ($1,$2,$3,$4,$4,0)
            """, db, tx);
        write.Parameters.AddWithValue(owner);
        write.Parameters.AddWithValue(proof.Secrets.Seal(owner, proof.Seed));
        write.Parameters.AddWithValue(proof.Step);
        write.Parameters.AddWithValue(source.Verified);
        if (await write.ExecuteNonQueryAsync(ct) != 1)
            throw new InvalidOperationException("The TOTP factor was not installed with the scoped Passkey.");
    }

    private static async Task VerifyLegacyMfaDestinationAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        LegacyMfaSource source, LegacyMfaProof proof, CancellationToken ct)
    {
        await using var read = new NpgsqlCommand("""
            SELECT sealed_seed FROM public.mfa_totp WHERE user_id=$1 AND last_step=$2
                AND verified_at=$3 AND retry_after=$3 AND failed_count=0
            """, db, tx);
        read.Parameters.AddWithValue(owner);
        read.Parameters.AddWithValue(proof.Step);
        read.Parameters.AddWithValue(source.Verified);
        if (await read.ExecuteScalarAsync(ct) is not byte[] sealedSeed)
            throw new InvalidOperationException("The approved TOTP factor or replay floor does not match.");
        byte[]? seed = null;
        try
        {
            seed = proof.Secrets.Open(owner, sealedSeed);
            if (!CryptographicOperations.FixedTimeEquals(seed, proof.Seed))
                throw new InvalidOperationException("The installed TOTP seed differs.");
        }
        catch (CryptographicException) { throw new InvalidOperationException("The installed TOTP envelope cannot be authenticated."); }
        finally { if (seed is not null) CryptographicOperations.ZeroMemory(seed); }
    }
}
