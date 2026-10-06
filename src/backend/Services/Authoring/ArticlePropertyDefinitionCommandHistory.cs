using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Exactly one real submitted command, including its original CAS and raw typed
/// payload. A recorded command is not a recipe reconstructed from an after-state.
/// </summary>
public sealed record ArticlePropertyDefinitionRecordedCommand(
    int HistoryVersion,
    CreateArticlePropertyDefinitionCommand? Create,
    UpdateArticlePropertyDefinitionCommand? Update,
    RenameArticlePropertyDefinitionCommand? Rename,
    DeprecateArticlePropertyDefinitionCommand? Deprecate,
    DeleteArticlePropertyDefinitionCommand? Delete)
{
    private (string Kind, ArticlePropertyDefinitionActor Actor, ArticlePropertyDefinitionOwner Owner,
        Guid DefinitionId, Guid RequestId, long OwnerRevision, long SchemaRevision) Identity
        => ArticlePropertyDefinitionCommandHistory.GetTag(this) switch
        {
            1 => ("create", Create!.Actor, Create!.Owner, Create!.DefinitionId, Create!.RequestId,
                Create!.ExpectedOwnerRevision, 0),
            2 => ("change-settings", Update!.Actor, Update!.Owner, Update!.DefinitionId, Update!.RequestId,
                Update!.ExpectedOwnerRevision, Update!.ExpectedSchemaRevision),
            3 => ("rename", Rename!.Actor, Rename!.Owner, Rename!.DefinitionId, Rename!.RequestId,
                Rename!.ExpectedOwnerRevision, Rename!.ExpectedSchemaRevision),
            4 => ("deprecate", Deprecate!.Actor, Deprecate!.Owner, Deprecate!.DefinitionId, Deprecate!.RequestId,
                Deprecate!.ExpectedOwnerRevision, Deprecate!.ExpectedSchemaRevision),
            5 => ("delete", Delete!.Actor, Delete!.Owner, Delete!.DefinitionId, Delete!.RequestId,
                Delete!.ExpectedOwnerRevision, Delete!.ExpectedSchemaRevision),
            _ => throw new ArticlePropertyDefinitionValidationException("article_property_history_command_invalid")
        };

    public string CommandKind => Identity.Kind;
    public ArticlePropertyDefinitionActor Actor => Identity.Actor;
    public ArticlePropertyDefinitionOwner Owner => Identity.Owner;
    public Guid DefinitionId => Identity.DefinitionId;
    public Guid RequestId => Identity.RequestId;
    public long ExpectedOwnerRevision => Identity.OwnerRevision;
    public long ExpectedSchemaRevision => Identity.SchemaRevision;
}

/// <summary>
/// One owner-sequenced mutation binding the captured command, actual impact facts
/// and existing receipt. The digest is public; authentication belongs to AuditLog.
/// </summary>
public sealed record ArticlePropertyDefinitionJournalEntry(
    int HistoryVersion,
    ArticlePropertyDefinitionOwner Owner,
    long Sequence,
    string PreviousDigest,
    ArticlePropertyDefinitionRecordedCommand Command,
    ArticlePropertyDefinitionImpact Impact,
    ArticlePropertyDefinitionWriteReceipt Receipt,
    string ContentDigest);

/// <summary>
/// Versioned, closed internal binary storage for definition commands. This codec
/// preserves raw payloads and ordering, not normalization or public wire semantics.
/// </summary>
public static class ArticlePropertyDefinitionCommandHistory
{
    /// <summary>Exact storage format; an unknown version is not a legacy import path.</summary>
    public const int Version = 1;
    /// <summary>Storage envelope only; the existing definition schema budget remains unchanged.</summary>
    public const int MaxCommandPayloadBytes = 1_048_576;

    private static readonly UTF8Encoding s_utf8 = new(false, true);

    /// <summary>Freezes the submitted create payload without normalizing away raw facts.</summary>
    public static ArticlePropertyDefinitionRecordedCommand Capture(CreateArticlePropertyDefinitionCommand command)
        => Copy(new(Version, command, null, null, null, null));

    /// <summary>Freezes the submitted settings and both expected CAS revisions.</summary>
    public static ArticlePropertyDefinitionRecordedCommand Capture(UpdateArticlePropertyDefinitionCommand command)
        => Copy(new(Version, null, command, null, null, null));

    /// <summary>Freezes only the submitted rename projection and command identity.</summary>
    public static ArticlePropertyDefinitionRecordedCommand Capture(RenameArticlePropertyDefinitionCommand command)
        => Copy(new(Version, null, null, command, null, null));

    /// <summary>Records the real deprecate command, not an inferred lifecycle transition.</summary>
    public static ArticlePropertyDefinitionRecordedCommand Capture(DeprecateArticlePropertyDefinitionCommand command)
        => Copy(new(Version, null, null, null, command, null));

    /// <summary>Records deletion intent without deleting or recording article values.</summary>
    public static ArticlePropertyDefinitionRecordedCommand Capture(DeleteArticlePropertyDefinitionCommand command)
        => Copy(new(Version, null, null, null, null, command));

    /// <summary>Checks storage shape and limits; it does not replace authority schema validation.</summary>
    public static void Validate(ArticlePropertyDefinitionRecordedCommand command)
        => _ = Encode(command);

    /// <summary>
    /// Encodes the exact closed branch in little-endian storage form with strict UTF-8.
    /// Only the permission set is sorted; payload collection order is preserved.
    /// </summary>
    public static byte[] Encode(ArticlePropertyDefinitionRecordedCommand command)
    {
        ValidateShape(command);
        using var stream = new BoundedCommandStream();
        using var writer = new BinaryWriter(stream, s_utf8, leaveOpen: true);
        byte tag = GetTag(command);
        writer.Write(Version);
        writer.Write(tag);
        writer.Write(command.Actor.AdminPrincipalId);
        WriteList(writer, command.Actor.Permissions.Order(StringComparer.Ordinal).ToArray(),
            static (output, permission) => WriteString(output, permission));
        WriteNullable(writer, command.Owner.UserId, static (output, value) => output.Write(value));
        WriteString(writer, command.Owner.SiteScope);
        WriteGuid(writer, command.DefinitionId);
        WriteGuid(writer, command.RequestId);
        writer.Write(command.ExpectedOwnerRevision);
        if (tag != 1)
        {
            writer.Write(command.ExpectedSchemaRevision);
        }
        switch (tag)
        {
            case 1:
                CreateArticlePropertyDefinitionCommand create = command.Create!;
                WriteString(writer, create.MachineKey);
                WriteNames(writer, create.DisplayNames);
                WriteSettings(writer, create.ValueType, create.Cardinality, create.Required, create.Presence,
                    create.DefaultValue, create.Constraints, create.Options, create.ReferencePolicy, create.UrlPolicy,
                    create.SearchEligible, create.Filterable, create.Sortable, create.DisplayPlacement, create.VisibilityScope);
                break;
            case 2:
                UpdateArticlePropertyDefinitionCommand update = command.Update!;
                WriteSettings(writer, update.ValueType, update.Cardinality, update.Required, update.Presence,
                    update.DefaultValue, update.Constraints, update.Options, update.ReferencePolicy, update.UrlPolicy,
                    update.SearchEligible, update.Filterable, update.Sortable, update.DisplayPlacement, update.VisibilityScope);
                break;
            case 3:
                WriteNames(writer, command.Rename!.DisplayNames);
                break;
        }
        writer.Flush();
        return stream.ToArray();
    }

    /// <summary>
    /// Rejects unknown, truncated, oversized or noncanonical storage before returning
    /// a deep copy. Counts and available bytes are checked before allocating each list.
    /// </summary>
    public static ArticlePropertyDefinitionRecordedCommand Decode(ReadOnlySpan<byte> payload)
    {
        if (payload.Length is < 5 or > MaxCommandPayloadBytes)
        {
            throw InvalidPayload();
        }
        try
        {
            // The envelope is checked before this sole input copy or any collection allocation.
            var reader = new CommandReader(payload.ToArray());
            int version = reader.ReadInt32();
            byte tag = reader.ReadByte();
            if (version != Version || tag is < 1 or > 5)
            {
                throw InvalidPayload();
            }
            long principalId = reader.ReadInt64();
            // ValidateActor bounds normalized text, not raw padding. The checked
            // envelope/Take bound raw bytes while retaining the exact permission.
            string[] permissions = reader.ReadList(64, 4, () => reader.ReadString());
            var actor = new ArticlePropertyDefinitionActor(principalId, permissions);
            var owner = new ArticlePropertyDefinitionOwner(reader.ReadNullableInt64(), reader.ReadString());
            Guid definitionId = reader.ReadGuid();
            Guid requestId = reader.ReadGuid();
            long ownerRevision = reader.ReadInt64();
            long schemaRevision = tag == 1 ? 0 : reader.ReadInt64();
            ArticlePropertyDefinitionRecordedCommand command;
            if (tag == 1)
            {
                string machineKey = reader.ReadString();
                IReadOnlyList<ArticlePropertyLocalizedName> names = reader.ReadNames();
                Settings settings = reader.ReadSettings();
                command = new(Version, new(actor, owner, definitionId, requestId, ownerRevision, machineKey, names,
                    settings.ValueType, settings.Cardinality, settings.Required, settings.Presence, settings.DefaultValue,
                    settings.Constraints, settings.Options, settings.ReferencePolicy, settings.UrlPolicy,
                    settings.SearchEligible, settings.Filterable, settings.Sortable, settings.DisplayPlacement,
                    settings.VisibilityScope), null, null, null, null);
            }
            else if (tag == 2)
            {
                Settings settings = reader.ReadSettings();
                command = new(Version, null, new(actor, owner, definitionId, requestId, ownerRevision, schemaRevision,
                    settings.ValueType, settings.Cardinality, settings.Required, settings.Presence, settings.DefaultValue,
                    settings.Constraints, settings.Options, settings.ReferencePolicy, settings.UrlPolicy,
                    settings.SearchEligible, settings.Filterable, settings.Sortable, settings.DisplayPlacement,
                    settings.VisibilityScope), null, null, null);
            }
            else
            {
                command = tag switch
                {
                    3 => new(Version, null, null,
                        new(actor, owner, definitionId, requestId, ownerRevision, schemaRevision, reader.ReadNames()), null, null),
                    4 => new(Version, null, null, null,
                        new(actor, owner, definitionId, requestId, ownerRevision, schemaRevision), null),
                    5 => new(Version, null, null, null, null,
                        new(actor, owner, definitionId, requestId, ownerRevision, schemaRevision)),
                    _ => throw InvalidPayload()
                };
            }
            if (!reader.AtEnd || !payload.SequenceEqual(Encode(command)))
            {
                // This also refuses unordered/duplicate permission encodings, alternate
                // booleans, foreign branch fields and any noncanonical representation.
                throw InvalidPayload();
            }
            return command;
        }
        catch (Exception exception) when (exception is ArgumentException or OverflowException)
        {
            throw InvalidPayload();
        }
    }

    /// <summary>Describes the empty owner state; it is not an authenticated checkpoint.</summary>
    public static string ComputeGenesisDigest(ArticlePropertyDefinitionOwner owner)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        return ArticlePropertyDefinitionContract.ComputeCommandDigest(
            "article-property-definition-history-genesis-v1", Version, owner.UserId, owner.SiteScope, 0L, "empty");
    }

    /// <summary>
    /// Binds the canonical command, full receipt and actual impact into a public digest,
    /// excluding its own stored digest. It neither signs nor authenticates the entry.
    /// </summary>
    public static string ComputeEntryDigest(ArticlePropertyDefinitionJournalEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ArticlePropertyDefinitionContract.ValidateOwner(entry.Owner);
        if (entry.HistoryVersion != Version || entry.Sequence <= 0 || entry.Command is null
            || entry.Impact is null || entry.Impact.Obligations is null
            || entry.Impact.AffectedValueCount is < 0 || entry.Receipt is null)
        {
            throw InvalidPayload();
        }
        ValidateDigestShape(entry.PreviousDigest);
        ArticlePropertyDefinitionContract.ValidateReceipt(entry.Receipt);
        return ArticlePropertyDefinitionContract.ComputeCommandDigest(
            "article-property-definition-history-entry-v1", Version, entry.Owner.UserId, entry.Owner.SiteScope,
            entry.Sequence, entry.PreviousDigest, Convert.ToHexStringLower(SHA256.HashData(Encode(entry.Command))),
            ArticlePropertyDefinitionContract.ComputeReceiptDigest(entry.Receipt), entry.Impact.AffectedValueCount,
            ArticlePropertyDefinitionContract.ComputeObligationsDigest(entry.Impact.Obligations));
    }

    /// <summary>Supplies the exact existing audit writer payload, not an audit signature.</summary>
    public static string ComputeAuditEventInfo(ArticlePropertyDefinitionJournalEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ArgumentNullException.ThrowIfNull(entry.Receipt);
        ValidateDigestShape(entry.Receipt.AuditDigest);
        ValidateDigestShape(entry.ContentDigest);
        return $"article-property-definition-history-v1:{entry.Receipt.AuditDigest}:{entry.ContentDigest}";
    }

    internal static byte GetTag(ArticlePropertyDefinitionRecordedCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        int branches = (command.Create is null ? 0 : 1) + (command.Update is null ? 0 : 1)
            + (command.Rename is null ? 0 : 1) + (command.Deprecate is null ? 0 : 1) + (command.Delete is null ? 0 : 1);
        if (command.HistoryVersion != Version || branches != 1)
        {
            throw InvalidPayload();
        }
        return command.Create is not null ? (byte)1 : command.Update is not null ? (byte)2
            : command.Rename is not null ? (byte)3 : command.Deprecate is not null ? (byte)4 : (byte)5;
    }

    private static ArticlePropertyDefinitionRecordedCommand Copy(ArticlePropertyDefinitionRecordedCommand command)
        => Decode(Encode(command));

    private static void ValidateShape(ArticlePropertyDefinitionRecordedCommand command)
    {
        byte tag = GetTag(command);
        ArticlePropertyDefinitionContract.ValidateActor(command.Actor);
        ArticlePropertyDefinitionContract.ValidateOwner(command.Owner);
        ArticlePropertyDefinitionContract.ValidateRequestId(command.RequestId);
        if (command.DefinitionId == Guid.Empty || command.ExpectedOwnerRevision < 0
            || (tag != 1 && command.ExpectedSchemaRevision <= 0))
        {
            throw InvalidPayload();
        }
        if (command.Create is { } create)
        {
            ValidateNames(create.DisplayNames, requireName: true);
            ValidateSettings(create.ValueType, create.Cardinality, create.Presence, create.DefaultValue,
                create.Constraints, create.Options, create.ReferencePolicy, create.UrlPolicy,
                create.DisplayPlacement, create.VisibilityScope);
        }
        if (command.Update is { } update)
        {
            ValidateSettings(update.ValueType, update.Cardinality, update.Presence, update.DefaultValue,
                update.Constraints, update.Options, update.ReferencePolicy, update.UrlPolicy,
                update.DisplayPlacement, update.VisibilityScope);
        }
        if (command.Rename is { } rename)
        {
            ValidateNames(rename.DisplayNames, requireName: true);
        }
    }

    private static void ValidateNames(IReadOnlyList<ArticlePropertyLocalizedName> names, bool requireName)
    {
        if (names is null || names.Count > ArticlePropertyDefinitionContract.MaxDisplayNames
            || (requireName && names.Count == 0) || names.Any(static name => name is null))
        {
            throw InvalidPayload();
        }
    }

    private static void ValidateSettings(
        ArticlePropertyValueType valueType, ArticlePropertyCardinality cardinality, ArticlePropertyPresencePolicy presence,
        ArticlePropertyDefaultValue? defaultValue, ArticlePropertyConstraints constraints,
        IReadOnlyList<ArticlePropertyOption> options, ArticlePropertyReferencePolicy? referencePolicy,
        ArticlePropertyUrlPolicy? urlPolicy, ArticlePropertyDisplayPlacement displayPlacement,
        ArticlePropertyVisibilityScope visibilityScope)
    {
        ArticlePropertyDefinitionContract.ValidateCommandPayloadShape(presence, defaultValue, constraints, options, urlPolicy);
        ValidateEnum(valueType);
        ValidateEnum(cardinality);
        ValidateEnum(presence.Missing);
        ValidateEnum(presence.Null);
        ValidateEnum(presence.Empty);
        ValidateEnum(displayPlacement);
        ValidateEnum(visibilityScope);
        if (defaultValue is not null)
        {
            ValidateEnum(defaultValue.Kind);
        }
        foreach (ArticlePropertyOption option in options)
        {
            if (option is null)
            {
                throw InvalidPayload();
            }
            ValidateEnum(option.Status);
            ValidateNames(option.LocalizedLabels, requireName: false);
        }
        if (referencePolicy is not null)
        {
            ValidateEnum(referencePolicy.Cardinality);
            ValidateEnum(referencePolicy.Permission);
        }
        if (urlPolicy is not null)
        {
            ValidateEnum(urlPolicy.Normalization);
            if (urlPolicy.AllowedSchemes.Count > ArticlePropertyDefinitionContract.MaxAllowedSchemes)
            {
                throw InvalidPayload();
            }
        }
        // Raw defaults, labels, scheme casing and collection order are deliberately
        // retained. The existing Store normalization/schema validation is still required.
    }

    private static void ValidateEnum<T>(T value) where T : struct, Enum
    {
        if (!Enum.IsDefined(value))
        {
            throw InvalidPayload();
        }
    }

    private static void ValidateDigestShape(string digest)
    {
        if (digest is null || digest.Length != 64
            || digest.Any(static character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw InvalidPayload();
        }
    }

    private static ArticlePropertyDefinitionValidationException InvalidPayload()
        => new("article_property_history_command_invalid");

    private static void WriteString(BinaryWriter writer, string value)
    {
        if (value is null)
        {
            throw InvalidPayload();
        }
        int length;
        try
        {
            length = s_utf8.GetByteCount(value);
        }
        catch (EncoderFallbackException)
        {
            throw InvalidPayload();
        }
        ((BoundedCommandStream)writer.BaseStream).EnsureAvailable(4L + length);
        writer.Write(length);
        writer.Write(s_utf8.GetBytes(value));
    }

    private static void WriteGuid(BinaryWriter writer, Guid value)
        => writer.Write(value.ToByteArray());

    private static void WriteNullable<T>(BinaryWriter writer, T? value, Action<BinaryWriter, T> write)
        where T : struct
    {
        writer.Write(value.HasValue);
        if (value.HasValue)
        {
            write(writer, value.Value);
        }
    }

    private static void WriteList<T>(BinaryWriter writer, IReadOnlyList<T> values, Action<BinaryWriter, T> write)
    {
        writer.Write(values.Count);
        foreach (T value in values)
        {
            write(writer, value);
        }
    }

    private static void WriteNames(BinaryWriter writer, IReadOnlyList<ArticlePropertyLocalizedName> names)
        => WriteList(writer, names, static (output, name) =>
        {
            WriteString(output, name.Locale);
            WriteString(output, name.Value);
        });

    private static void WriteDecimal(BinaryWriter writer, decimal value)
    {
        foreach (int part in decimal.GetBits(value))
        {
            writer.Write(part);
        }
    }

    private static void WriteDate(BinaryWriter writer, DateTime value)
    {
        if (value.Kind != DateTimeKind.Utc)
        {
            throw InvalidPayload();
        }
        writer.Write(value.Ticks);
    }

    private static void WriteSettings(
        BinaryWriter writer, ArticlePropertyValueType valueType, ArticlePropertyCardinality cardinality,
        bool required, ArticlePropertyPresencePolicy presence, ArticlePropertyDefaultValue? defaultValue,
        ArticlePropertyConstraints constraints, IReadOnlyList<ArticlePropertyOption> options,
        ArticlePropertyReferencePolicy? referencePolicy, ArticlePropertyUrlPolicy? urlPolicy,
        bool searchEligible, bool filterable, bool sortable, ArticlePropertyDisplayPlacement displayPlacement,
        ArticlePropertyVisibilityScope visibilityScope)
    {
        writer.Write((short)valueType);
        writer.Write((short)cardinality);
        writer.Write(required);
        writer.Write((short)presence.Missing);
        writer.Write((short)presence.Null);
        writer.Write((short)presence.Empty);
        writer.Write(defaultValue is not null);
        if (defaultValue is not null)
        {
            writer.Write((short)defaultValue.Kind);
            writer.Write(defaultValue.Scalar is not null);
            if (defaultValue.Scalar is not null)
            {
                WriteString(writer, defaultValue.Scalar);
            }
            WriteList(writer, defaultValue.OptionIds, WriteGuid);
            WriteList(writer, defaultValue.ArticleIds, static (output, value) => output.Write(value));
        }
        WriteNullable(writer, constraints.MinLength, static (output, value) => output.Write(value));
        WriteNullable(writer, constraints.MaxLength, static (output, value) => output.Write(value));
        WriteNullable(writer, constraints.MinNumber, WriteDecimal);
        WriteNullable(writer, constraints.MaxNumber, WriteDecimal);
        WriteNullable(writer, constraints.MinDateUtc, WriteDate);
        WriteNullable(writer, constraints.MaxDateUtc, WriteDate);
        WriteNullable(writer, constraints.MinItems, static (output, value) => output.Write(value));
        WriteNullable(writer, constraints.MaxItems, static (output, value) => output.Write(value));
        WriteList(writer, options, static (output, option) =>
        {
            WriteGuid(output, option.OptionId);
            WriteString(output, option.Label);
            output.Write(option.Order);
            output.Write((short)option.Status);
            WriteNames(output, option.LocalizedLabels);
        });
        writer.Write(referencePolicy is not null);
        if (referencePolicy is not null)
        {
            writer.Write((short)referencePolicy.Cardinality);
            writer.Write((short)referencePolicy.Permission);
            writer.Write(referencePolicy.AllowCrossSite);
            writer.Write(referencePolicy.AllowDeleted);
            writer.Write(referencePolicy.AllowArchived);
            writer.Write(referencePolicy.AllowSelfReference);
            writer.Write(referencePolicy.AllowCycles);
        }
        writer.Write(urlPolicy is not null);
        if (urlPolicy is not null)
        {
            WriteList(writer, urlPolicy.AllowedSchemes, WriteString);
            writer.Write(urlPolicy.AllowRelative);
            writer.Write(urlPolicy.AllowAbsolute);
            writer.Write(urlPolicy.MaxLength);
            writer.Write((short)urlPolicy.Normalization);
        }
        writer.Write(searchEligible);
        writer.Write(filterable);
        writer.Write(sortable);
        writer.Write((short)displayPlacement);
        writer.Write((short)visibilityScope);
    }

    private sealed record Settings(
        ArticlePropertyValueType ValueType, ArticlePropertyCardinality Cardinality, bool Required,
        ArticlePropertyPresencePolicy Presence, ArticlePropertyDefaultValue? DefaultValue,
        ArticlePropertyConstraints Constraints, IReadOnlyList<ArticlePropertyOption> Options,
        ArticlePropertyReferencePolicy? ReferencePolicy, ArticlePropertyUrlPolicy? UrlPolicy,
        bool SearchEligible, bool Filterable, bool Sortable, ArticlePropertyDisplayPlacement DisplayPlacement,
        ArticlePropertyVisibilityScope VisibilityScope);

    private sealed class CommandReader(byte[] payload)
    {
        private readonly byte[] _payload = payload;
        private int _offset;

        public bool AtEnd => _offset == _payload.Length;

        private ReadOnlySpan<byte> Take(int length)
        {
            if (length < 0 || length > _payload.Length - _offset)
            {
                throw InvalidPayload();
            }
            ReadOnlySpan<byte> result = _payload.AsSpan(_offset, length);
            _offset += length;
            return result;
        }

        public byte ReadByte() => Take(1)[0];
        public short ReadInt16() => BinaryPrimitives.ReadInt16LittleEndian(Take(2));
        public int ReadInt32() => BinaryPrimitives.ReadInt32LittleEndian(Take(4));
        public long ReadInt64() => BinaryPrimitives.ReadInt64LittleEndian(Take(8));
        public Guid ReadGuid() => new(Take(16));

        private bool ReadBoolean() => ReadByte() switch
        {
            0 => false,
            1 => true,
            _ => throw InvalidPayload()
        };

        public string ReadString(int maxBytes = MaxCommandPayloadBytes)
        {
            int length = ReadInt32();
            if (length < 0 || length > maxBytes)
            {
                throw InvalidPayload();
            }
            return s_utf8.GetString(Take(length));
        }

        public T[] ReadList<T>(int maxCount, int minimumItemBytes, Func<T> read)
        {
            int count = ReadInt32();
            if (count < 0 || count > maxCount || (long)count * minimumItemBytes > _payload.Length - _offset)
            {
                throw InvalidPayload();
            }
            var values = new T[count];
            for (int index = 0; index < count; index++)
            {
                values[index] = read();
            }
            return values;
        }

        public long? ReadNullableInt64() => ReadBoolean() ? ReadInt64() : null;
        private int? ReadNullableInt32() => ReadBoolean() ? ReadInt32() : null;
        private decimal? ReadNullableDecimal()
            => ReadBoolean() ? new decimal(new[] { ReadInt32(), ReadInt32(), ReadInt32(), ReadInt32() }) : null;
        private DateTime? ReadNullableDate()
            => ReadBoolean() ? new DateTime(ReadInt64(), DateTimeKind.Utc) : null;

        public IReadOnlyList<ArticlePropertyLocalizedName> ReadNames()
            => Array.AsReadOnly(ReadList(ArticlePropertyDefinitionContract.MaxDisplayNames, 8,
                () => new ArticlePropertyLocalizedName(ReadString(), ReadString())));

        public Settings ReadSettings()
        {
            var valueType = (ArticlePropertyValueType)ReadInt16();
            var cardinality = (ArticlePropertyCardinality)ReadInt16();
            bool required = ReadBoolean();
            var presence = new ArticlePropertyPresencePolicy((ArticlePropertyMissingBehavior)ReadInt16(),
                (ArticlePropertyNullBehavior)ReadInt16(), (ArticlePropertyEmptyBehavior)ReadInt16());
            ArticlePropertyDefaultValue? defaultValue = null;
            if (ReadBoolean())
            {
                var kind = (ArticlePropertyDefaultKind)ReadInt16();
                string? scalar = ReadBoolean() ? ReadString() : null;
                Guid[] optionIds = ReadList(ArticlePropertyDefinitionContract.MaxOptionsPerDefinition, 16, ReadGuid);
                long[] articleIds = ReadList(ArticlePropertyDefinitionContract.MaxReferenceIdsPerDefault, 8, ReadInt64);
                defaultValue = new(kind, scalar, optionIds, articleIds);
            }
            var constraints = new ArticlePropertyConstraints(ReadNullableInt32(), ReadNullableInt32(),
                ReadNullableDecimal(), ReadNullableDecimal(), ReadNullableDate(), ReadNullableDate(),
                ReadNullableInt32(), ReadNullableInt32());
            IReadOnlyList<ArticlePropertyOption> options = Array.AsReadOnly(
                ReadList(ArticlePropertyDefinitionContract.MaxOptionsPerDefinition, 30,
                    () => new ArticlePropertyOption(ReadGuid(), ReadString(), ReadInt32(),
                        (ArticlePropertyOptionStatus)ReadInt16(), ReadNames())));
            ArticlePropertyReferencePolicy? referencePolicy = ReadBoolean()
                ? new((ArticlePropertyCardinality)ReadInt16(), (ArticlePropertyReferencePermission)ReadInt16(),
                    ReadBoolean(), ReadBoolean(), ReadBoolean(), ReadBoolean(), ReadBoolean()) : null;
            ArticlePropertyUrlPolicy? urlPolicy = ReadBoolean()
                ? new(ReadList(ArticlePropertyDefinitionContract.MaxAllowedSchemes, 4, () => ReadString()),
                    ReadBoolean(), ReadBoolean(), ReadInt32(), (ArticlePropertyUrlNormalization)ReadInt16()) : null;
            return new(valueType, cardinality, required, presence, defaultValue, constraints, options,
                referencePolicy, urlPolicy, ReadBoolean(), ReadBoolean(), ReadBoolean(),
                (ArticlePropertyDisplayPlacement)ReadInt16(), (ArticlePropertyVisibilityScope)ReadInt16());
        }
    }

    private sealed class BoundedCommandStream : MemoryStream
    {
        public void EnsureAvailable(long length)
        {
            if (length < 0 || length > MaxCommandPayloadBytes - Position)
            {
                throw new ArticlePropertyDefinitionBudgetExceededException("article_property_command_payload_budget_exceeded");
            }
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            EnsureAvailable(count);
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            EnsureAvailable(buffer.Length);
            base.Write(buffer);
        }

        public override void WriteByte(byte value)
        {
            EnsureAvailable(1);
            base.WriteByte(value);
        }
    }
}
