namespace FsusBlog.V2.Contracts;

public sealed record PasskeyLoginRequest(string Token, string CredentialId, byte[] RawId, byte[] ClientData,
    byte[] AuthenticatorData, byte[] Signature, byte[] UserHandle, bool RememberMe);

public sealed record PasskeyProvisionRequest(string Token, string CredentialId, byte[] RawId, byte[] ClientData,
    byte[] Attestation, int[] Transports);

public static class PasskeyWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] LoginBegin(string token, uint timeout, string rpId, byte[] challenge,
        IReadOnlyList<byte[]>? allowed = null)
    {
        var rp = Utf8.GetBytes(rpId);
        allowed ??= [];
        var descriptors = Descriptors(allowed, rp.Length + challenge.Length);
        var payload = Begin(PasskeyLoginBeginSize, descriptors, PasskeyLoginBeginTokenOffset, token, timeout,
            [rp, challenge, .. allowed], referenceCount: 2);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(8), allowed.Count);
        return Aeds.Encode(FrameType.PasskeyLoginBegin, payload);
    }

    public static byte[] ProvisionBegin(string token, uint timeout, string rpId, string rpName, string userName,
        string displayName, byte[] userHandle, byte[] challenge, IReadOnlyList<int> algorithms)
    {
        return RegistrationBegin(token, timeout, [Utf8.GetBytes(rpId), Utf8.GetBytes(rpName), Utf8.GetBytes(userName),
            Utf8.GetBytes(displayName), userHandle, challenge], algorithms, []);
    }

    public static byte[] EnrollmentBegin(string token, uint timeout, string rpId, string rpName, string userName,
        string displayName, byte[] userHandle, byte[] challenge, IReadOnlyList<int> algorithms, IReadOnlyList<byte[]> excluded)
    {
        if (timeout is < 1 or > 300_000 || userHandle.Length != PasskeyUserHandleBytes || challenge.Length != PasskeyChallengeBytes ||
            algorithms.Count is < 1 or > 16 || excluded.Count is < 1 or >= SitePasskeyListSize ||
            excluded.Any(id => id.Length is < 1 or > PasskeyCredentialIdBytes) ||
            excluded.Select(Convert.ToHexString).Distinct(StringComparer.Ordinal).Count() != excluded.Count)
            throw Invalid();
        return RegistrationBegin(token, timeout, [RequiredText(rpId, 253), RequiredText(rpName, 128), RequiredText(userName, 128),
            RequiredText(displayName, 128), userHandle, challenge], algorithms, excluded);
    }

    private static byte[] RegistrationBegin(string token, uint timeout, byte[][] fields,
        IReadOnlyList<int> algorithms, IReadOnlyList<byte[]> excluded)
    {
        var descriptors = Descriptors(excluded, fields.Sum(field => field.Length));
        var extra = new byte[algorithms.Count * 8 + descriptors.Length];
        for (var i = 0; i < algorithms.Count; i++)
            BinaryPrimitives.WriteInt32LittleEndian(extra.AsSpan(i * 8 + 4), algorithms[i]);
        descriptors.CopyTo(extra, algorithms.Count * 8);
        var payload = Begin(PasskeyRegisterBeginSize, extra, PasskeyRegisterBeginTokenOffset, token, timeout,
            [.. fields, .. excluded], referenceCount: fields.Length);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(8), algorithms.Count);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(12), excluded.Count);
        payload[33] = 1;
        return Aeds.Encode(FrameType.PasskeyRegisterBegin, payload);
    }

    private static byte[] Descriptors(IReadOnlyList<byte[]> credentials, int offset)
    {
        var bytes = new byte[credentials.Count * PasskeyCredentialDescriptorSize];
        for (var i = 0; i < credentials.Count; i++)
        {
            // The v1 descriptor repeats the transport count after the fixed record. Both counts are zero here.
            var descriptor = bytes.AsSpan(i * PasskeyCredentialDescriptorSize, PasskeyCredentialDescriptorSize);
            BinaryPrimitives.WriteInt32LittleEndian(descriptor[8..], offset);
            BinaryPrimitives.WriteInt32LittleEndian(descriptor[12..], credentials[i].Length);
            offset += credentials[i].Length;
        }
        return bytes;
    }

    private static byte[] RequiredText(string value, int max)
    {
        try
        {
            var length = Utf8.GetByteCount(value);
            if (length > 0 && length <= max)
                return Utf8.GetBytes(value);
        }
        catch (EncoderFallbackException) { throw Invalid(); }
        throw Invalid();
    }

    public static byte[] Authenticated(int accountId, string? mfaToken = null)
    {
        if (accountId <= 0) throw new ArgumentOutOfRangeException(nameof(accountId));
        var payload = new byte[PasskeyAuthLoginFlowSize];
        BinaryPrimitives.WriteInt32LittleEndian(payload, accountId);
        payload[4] = mfaToken is null ? (byte)1 : (byte)2;
        payload[5] = mfaToken is null ? (byte)0 : (byte)2;
        payload[6] = mfaToken is null ? (byte)0 : (byte)1;
        payload[7] = 1;
        "anonymous_account"u8.CopyTo(payload.AsSpan(8));
        if (mfaToken is not null)
        {
            if (mfaToken.Length != 43 || !Base64UrlText(mfaToken)) throw new ArgumentException("Invalid pending MFA token.", nameof(mfaToken));
            Encoding.ASCII.GetBytes(mfaToken, payload.AsSpan(104));
        }
        return Aeds.Encode(FrameType.AuthLoginFlow, payload);
    }

    public static byte[] AuthenticatedAdministrator()
    {
        var payload = new byte[PasskeyAuthLoginFlowSize];
        BinaryPrimitives.WriteInt32LittleEndian(payload, 1);
        payload[4] = 1;
        payload[7] = 1;
        "administrator"u8.CopyTo(payload.AsSpan(8));
        return Aeds.Encode(FrameType.AuthLoginFlow, payload);
    }

    public static PasskeyLoginRequest ReadLogin(ReadOnlySpan<byte> frame, bool discoverable = true)
    {
        var p = new Completion(Aeds.Decode(frame, FrameType.PasskeyLoginCompleteRequest), PasskeyLoginCompleteSize, 0);
        if (p.Meta[0] > 1 || p.Meta[1] > 1 || (discoverable && p.Meta[1] != 1) || !p.Meta[2..8].SequenceEqual(stackalloc byte[6]))
            throw Invalid();
        var id = p.Text(0, PasskeyCredentialIdBytes * 2);
        var raw = p.Bytes(1, PasskeyCredentialIdBytes);
        var result = new PasskeyLoginRequest(p.Token, id, raw, p.Bytes(2, PasskeyClientDataBytes),
            p.Bytes(3, PasskeyAuthenticatorDataBytes), p.Bytes(4, PasskeySignatureBytes), p.Meta[1] == 1 ? p.Bytes(5, PasskeyUserHandleBytes) : [],
            p.Meta[0] == 1);
        if (p.Meta[1] == 0) p.Absent(5);
        p.Finish();
        if (result.UserHandle.Length != (p.Meta[1] == 1 ? PasskeyUserHandleBytes : 0)) throw Invalid();
        return result;
    }

    public static PasskeyProvisionRequest ReadProvision(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, FrameType.PasskeyRegisterCompleteRequest);
        if (payload.Length < PasskeyRegisterCompleteSize || !payload[..4].SequenceEqual(stackalloc byte[4])) throw Invalid();
        var transportCount = BinaryPrimitives.ReadInt32LittleEndian(payload[4..]);
        if (transportCount is < 0 or > PasskeyTransportCount) throw Invalid();
        var p = new Completion(payload, PasskeyRegisterCompleteSize, transportCount * 4);
        var transports = new int[transportCount];
        for (var i = 0; i < transportCount; i++)
        {
            var value = BinaryPrimitives.ReadInt32LittleEndian(p.Extra[(i * 4)..]);
            if (value is < 0 or >= PasskeyTransportCount || transports.AsSpan(0, i).Contains(value)) throw Invalid();
            transports[i] = value;
        }
        var result = new PasskeyProvisionRequest(p.Token, p.Text(0, PasskeyCredentialIdBytes * 2), p.Bytes(1, PasskeyCredentialIdBytes),
            p.Bytes(2, PasskeyClientDataBytes), p.Bytes(3, PasskeyAttestationBytes), transports);
        p.Absent(4);
        p.Absent(5);
        p.Finish();
        return result;
    }

    private static byte[] Begin(int size, byte[] extra, int tokenOffset, string token, uint timeout, byte[][] fields, int? referenceCount = null)
    {
        if (token.Length != 43 || !Base64UrlText(token)) throw new ArgumentException("Invalid passkey challenge token.", nameof(token));
        var blobSize = fields.Sum(field => field.Length);
        var payload = new byte[size + extra.Length + 4 + blobSize];
        BinaryPrimitives.WriteUInt64LittleEndian(payload, timeout);
        Encoding.ASCII.GetBytes(token, payload.AsSpan(tokenOffset, PasskeyTokenSize));
        extra.CopyTo(payload, size);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(size + extra.Length), blobSize);
        var blob = payload.AsSpan(size + extra.Length + 4);
        var offset = 0;
        for (var i = 0; i < fields.Length; i++)
        {
            if (i < (referenceCount ?? fields.Length))
            {
                var reference = payload.AsSpan(tokenOffset + PasskeyTokenSize + i * PasskeySliceSize);
                BinaryPrimitives.WriteInt32LittleEndian(reference, offset);
                BinaryPrimitives.WriteInt32LittleEndian(reference[4..], fields[i].Length);
            }
            fields[i].CopyTo(blob[offset..]);
            offset += fields[i].Length;
        }
        return payload;
    }

    private static bool Base64UrlText(string text) => text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static ProtocolException Invalid() => new("Invalid Passkey AEDS payload.");

    private ref struct Completion
    {
        private int _position;
        private readonly ReadOnlySpan<byte> _blob;
        internal readonly ReadOnlySpan<byte> Meta;
        internal readonly ReadOnlySpan<byte> Extra;
        internal readonly string Token;

        internal Completion(ReadOnlySpan<byte> payload, int header, int extra)
        {
            if (payload.Length < header + extra + 4 || payload.Length + Aeds.HeaderSize > MaxPasskeyFrameBytes) throw Invalid();
            Meta = payload[..header];
            Extra = payload.Slice(header, extra);
            _blob = payload[(header + extra + 4)..];
            if (BinaryPrimitives.ReadInt32LittleEndian(payload[(header + extra)..]) != _blob.Length) throw Invalid();
            var text = Meta.Slice(PasskeyCompleteTokenOffset, PasskeyTokenSize);
            if (text.IndexOf((byte)0) != 43 || text[43..].ContainsAnyExcept((byte)0)) throw Invalid();
            Token = Encoding.ASCII.GetString(text[..43]);
            if (!Base64UrlText(Token)) throw Invalid();
        }

        internal string Text(int field, int max)
        {
            var bytes = Bytes(field, max);
            try { return Utf8.GetString(bytes); }
            catch (DecoderFallbackException) { throw Invalid(); }
        }

        internal byte[] Bytes(int field, int max)
        {
            var (offset, length) = Slice(field);
            if (length <= 0 || length > max || offset != _position || length > _blob.Length - offset) throw Invalid();
            _position += length;
            return _blob.Slice(offset, length).ToArray();
        }

        internal void Absent(int field)
        {
            if (Slice(field) != (_position, 0)) throw Invalid();
        }

        internal void Finish()
        {
            if (_position != _blob.Length) throw Invalid();
        }

        private (int, int) Slice(int field)
        {
            var data = Meta[(PasskeyCompleteBlobRefsOffset + field * PasskeySliceSize)..];
            return (BinaryPrimitives.ReadInt32LittleEndian(data), BinaryPrimitives.ReadInt32LittleEndian(data[4..]));
        }
    }
}
