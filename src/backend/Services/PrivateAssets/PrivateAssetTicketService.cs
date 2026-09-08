using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.PrivateAssets;

internal sealed class PrivateAssetTicketOptions
{
    internal static readonly TimeSpan s_defaultTimeToLive = TimeSpan.FromMinutes(5);
    internal static readonly TimeSpan s_minimumTimeToLive = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan s_maximumTimeToLive = TimeSpan.FromMinutes(10);

    public TimeSpan TimeToLive { get; set; } = s_defaultTimeToLive;
}

internal sealed class PrivateAssetTicketOptionsValidator : IValidateOptions<PrivateAssetTicketOptions>
{
    public ValidateOptionsResult Validate(string? name, PrivateAssetTicketOptions options)
        => options.TimeToLive >= PrivateAssetTicketOptions.s_minimumTimeToLive
            && options.TimeToLive <= PrivateAssetTicketOptions.s_maximumTimeToLive
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail("PrivateAssets:TicketTimeToLive must be between 30 seconds and 10 minutes.");
}

internal sealed record PrivateAssetTicketPayload(
    AssetId AssetId,
    PrivateAssetAccessPurpose Purpose,
    DateTimeOffset IssuedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    string? SubjectPrincipalId,
    byte[] Nonce);

internal sealed class PrivateAssetTicketService
{
    internal const string ProtectorPurpose = "FsusBlog.PrivateAssetTicket.v1";
    private const byte SchemaVersion = 1;
    private const int NonceLength = 16;
    private static readonly UTF8Encoding s_strictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private readonly IDataProtector _protector;
    private readonly TimeProvider _timeProvider;
    private readonly PrivateAssetTicketOptions _options;

    public PrivateAssetTicketService(
        IDataProtectionProvider provider,
        TimeProvider timeProvider,
        IOptions<PrivateAssetTicketOptions> options)
    {
        _protector = provider.CreateProtector(ProtectorPurpose);
        _timeProvider = timeProvider;
        _options = options.Value;
    }

    public PrivateAssetTicketIssueResult Protect(
        AssetId assetId,
        PrivateAssetAccessPurpose purpose,
        string? subjectPrincipalId)
    {
        if (assetId.Value == Guid.Empty)
        {
            throw new ArgumentException("Private asset id is required.", nameof(assetId));
        }

        if (!PrivateAssetAccessPurpose.TryParse(purpose.Value, out PrivateAssetAccessPurpose parsedPurpose)
            || parsedPurpose != purpose)
        {
            throw new ArgumentException("Private asset access purpose is invalid.", nameof(purpose));
        }

        if (!IsValidSubject(subjectPrincipalId))
        {
            throw new ArgumentException("Private asset subject principal id is invalid.", nameof(subjectPrincipalId));
        }

        DateTimeOffset issuedAtUtc = _timeProvider.GetUtcNow();
        DateTimeOffset expiresAtUtc = issuedAtUtc.Add(_options.TimeToLive);
        var payload = new PrivateAssetTicketPayload(
            assetId,
            purpose,
            issuedAtUtc,
            expiresAtUtc,
            subjectPrincipalId,
            RandomNumberGenerator.GetBytes(NonceLength));
        return new PrivateAssetTicketIssueResult(
            WebEncoders.Base64UrlEncode(_protector.Protect(Serialize(payload))),
            expiresAtUtc);
    }

    public bool TryUnprotect(string? ticket, out PrivateAssetTicketPayload? payload)
    {
        payload = null;
        if (string.IsNullOrWhiteSpace(ticket) || ticket.Length > 4096)
        {
            return false;
        }

        try
        {
            byte[] plaintext = _protector.Unprotect(WebEncoders.Base64UrlDecode(ticket));
            if (!TryDeserialize(plaintext, out payload) || payload is null)
            {
                return false;
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            return payload.IssuedAtUtc <= now && now < payload.ExpiresAtUtc;
        }
        catch (Exception exception) when (exception is CryptographicException or FormatException)
        {
            return false;
        }
    }

    internal static byte[] Serialize(PrivateAssetTicketPayload payload)
    {
        byte[] purpose = Encoding.UTF8.GetBytes(payload.Purpose.Value);
        byte[] subject = payload.SubjectPrincipalId is null
            ? []
            : Encoding.UTF8.GetBytes(payload.SubjectPrincipalId);
        int length = 1 + 16 + 8 + 8 + 1 + purpose.Length + 2 + subject.Length + NonceLength;
        byte[] buffer = new byte[length];
        Span<byte> span = buffer;
        int offset = 0;
        span[offset++] = SchemaVersion;
        payload.AssetId.Value.TryWriteBytes(span.Slice(offset, 16), bigEndian: true, out _);
        offset += 16;
        BinaryPrimitives.WriteInt64BigEndian(span.Slice(offset, 8), payload.IssuedAtUtc.UtcTicks);
        offset += 8;
        BinaryPrimitives.WriteInt64BigEndian(span.Slice(offset, 8), payload.ExpiresAtUtc.UtcTicks);
        offset += 8;
        span[offset++] = checked((byte)purpose.Length);
        purpose.CopyTo(span[offset..]);
        offset += purpose.Length;
        BinaryPrimitives.WriteUInt16BigEndian(span.Slice(offset, 2), checked((ushort)subject.Length));
        offset += 2;
        subject.CopyTo(span[offset..]);
        offset += subject.Length;
        payload.Nonce.CopyTo(span[offset..]);
        return buffer;
    }

    internal static bool TryDeserialize(byte[] plaintext, out PrivateAssetTicketPayload? payload)
    {
        payload = null;
        ReadOnlySpan<byte> span = plaintext;
        const int MinimumLength = 1 + 16 + 8 + 8 + 1 + 2 + NonceLength;
        if (span.Length < MinimumLength || span[0] != SchemaVersion)
        {
            return false;
        }

        int offset = 1;
        var guid = new Guid(span.Slice(offset, 16), bigEndian: true);
        offset += 16;
        long issuedTicks = BinaryPrimitives.ReadInt64BigEndian(span.Slice(offset, 8));
        offset += 8;
        long expiresTicks = BinaryPrimitives.ReadInt64BigEndian(span.Slice(offset, 8));
        offset += 8;
        int purposeLength = span[offset++];
        if (purposeLength == 0 || offset + purposeLength + 2 + NonceLength > span.Length)
        {
            return false;
        }

        if (!TryDecodeUtf8(span.Slice(offset, purposeLength), out string purposeText))
        {
            return false;
        }

        offset += purposeLength;
        int subjectLength = BinaryPrimitives.ReadUInt16BigEndian(span.Slice(offset, 2));
        offset += 2;
        if (offset + subjectLength + NonceLength != span.Length
            || !PrivateAssetAccessPurpose.TryParse(purposeText, out PrivateAssetAccessPurpose purpose))
        {
            return false;
        }

        string? subject = null;
        if (subjectLength > 0
            && !TryDecodeUtf8(span.Slice(offset, subjectLength), out subject))
        {
            return false;
        }

        offset += subjectLength;
        if (!IsValidSubject(subject))
        {
            return false;
        }

        byte[] nonce = span.Slice(offset, NonceLength).ToArray();
        try
        {
            var issuedAtUtc = new DateTimeOffset(issuedTicks, TimeSpan.Zero);
            var expiresAtUtc = new DateTimeOffset(expiresTicks, TimeSpan.Zero);
            TimeSpan timeToLive = expiresAtUtc - issuedAtUtc;
            if (guid == Guid.Empty
                || timeToLive < PrivateAssetTicketOptions.s_minimumTimeToLive
                || timeToLive > PrivateAssetTicketOptions.s_maximumTimeToLive)
            {
                return false;
            }

            payload = new PrivateAssetTicketPayload(
                AssetId.FromGuid(guid),
                purpose,
                issuedAtUtc,
                expiresAtUtc,
                subject,
                nonce);
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static bool IsValidSubject(string? subject)
        => subject is null
            || (!string.IsNullOrWhiteSpace(subject)
                && subject.Length <= 128
                && !subject.Any(char.IsControl));

    private static bool TryDecodeUtf8(ReadOnlySpan<byte> bytes, out string value)
    {
        try
        {
            value = s_strictUtf8.GetString(bytes);
            return true;
        }
        catch (DecoderFallbackException)
        {
            value = string.Empty;
            return false;
        }
    }
}
