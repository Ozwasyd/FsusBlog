using System.Data.Common;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Customization;

/// <summary>
/// PostgreSQL-backed store for the customization profile bounded context.
/// </summary>
public sealed class PostgresCustomizationProfileStore(ISqlSugarClient db) : ICustomizationProfileStore
{
    public async Task<IReadOnlyList<CustomizationProfile>> ListProfilesAsync(
        int userId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, user_id, name, created_at_utc, updated_at_utc
            FROM customization_profile
            WHERE user_id = @UserId
            ORDER BY id;
            """,
            new SugarParameter("@UserId", userId)).ConfigureAwait(false);

        var profiles = new List<CustomizationProfile>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            profiles.Add(ReadProfile(reader));
        }
        return profiles.AsReadOnly();
    }

    public async Task<CustomizationProfile?> GetProfileAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, user_id, name, created_at_utc, updated_at_utc
            FROM customization_profile
            WHERE id = @ProfileId;
            """,
            new SugarParameter("@ProfileId", profileId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadProfile(reader)
            : null;
    }

    public async Task<CustomizationProfile> CreateProfileAsync(
        int userId,
        string name,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO customization_profile (user_id, name, created_at_utc, updated_at_utc)
            VALUES (@UserId, @Name, @CreatedAtUtc, @UpdatedAtUtc)
            RETURNING id, user_id, name, created_at_utc, updated_at_utc;
            """,
            new SugarParameter("@UserId", userId),
            new SugarParameter("@Name", name),
            new SugarParameter("@CreatedAtUtc", createdAtUtc),
            new SugarParameter("@UpdatedAtUtc", createdAtUtc)).ConfigureAwait(false);

        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        return ReadProfile(reader);
    }

    public async Task<IReadOnlyList<CustomizationVersion>> ListVersionsAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, profile_id, version, payload::text, created_at_utc
            FROM customization_version
            WHERE profile_id = @ProfileId
            ORDER BY version DESC;
            """,
            new SugarParameter("@ProfileId", profileId)).ConfigureAwait(false);

        var versions = new List<CustomizationVersion>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            versions.Add(ReadVersion(reader));
        }
        return versions.AsReadOnly();
    }

    public async Task<CustomizationVersion> CreateVersionAsync(
        long profileId,
        string payload,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO customization_version (profile_id, version, payload, created_at_utc)
            VALUES (
                @ProfileId,
                (SELECT COALESCE(MAX(version), 0) + 1 FROM customization_version WHERE profile_id = @ProfileId),
                CAST(@Payload AS jsonb),
                @CreatedAtUtc
            )
            RETURNING id, profile_id, version, payload::text, created_at_utc;
            """,
            new SugarParameter("@ProfileId", profileId),
            new SugarParameter("@Payload", payload),
            new SugarParameter("@CreatedAtUtc", createdAtUtc)).ConfigureAwait(false);

        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        return ReadVersion(reader);
    }

    public async Task<CustomizationVersion?> GetVersionAsync(
        long versionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, profile_id, version, payload::text, created_at_utc
            FROM customization_version
            WHERE id = @VersionId;
            """,
            new SugarParameter("@VersionId", versionId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadVersion(reader)
            : null;
    }

    public async Task<CustomizationDraft?> GetDraftAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, profile_id, version_id, payload::text, etag, updated_at_utc
            FROM customization_draft
            WHERE profile_id = @ProfileId;
            """,
            new SugarParameter("@ProfileId", profileId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadDraft(reader)
            : null;
    }

    public async Task<CustomizationDraft?> UpsertDraftAsync(
        long profileId,
        long? versionId,
        string payload,
        string newEtag,
        string? expectedEtag,
        DateTime updatedAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (expectedEtag is null)
        {
            // Insert a new draft if none exists, or replace unconditionally.
            using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                INSERT INTO customization_draft (profile_id, version_id, payload, etag, updated_at_utc)
                VALUES (@ProfileId, @VersionId, CAST(@Payload AS jsonb), @Etag, @UpdatedAtUtc)
                ON CONFLICT (profile_id)
                DO UPDATE SET version_id = EXCLUDED.version_id,
                              payload = EXCLUDED.payload,
                              etag = EXCLUDED.etag,
                              updated_at_utc = EXCLUDED.updated_at_utc
                RETURNING id, profile_id, version_id, payload::text, etag, updated_at_utc;
                """,
                new SugarParameter("@ProfileId", profileId),
                new SugarParameter("@VersionId", versionId is null ? DBNull.Value : versionId.Value),
                new SugarParameter("@Payload", payload),
                new SugarParameter("@Etag", newEtag),
                new SugarParameter("@UpdatedAtUtc", updatedAtUtc)).ConfigureAwait(false);

            await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            return ReadDraft(reader);
        }

        // Optimistic concurrency: only update if the stored etag matches.
        using (var currentReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT etag FROM customization_draft WHERE profile_id = @ProfileId;
            """,
            new SugarParameter("@ProfileId", profileId)).ConfigureAwait(false))
        {
            bool hasRow = await currentReader.ReadAsync(cancellationToken).ConfigureAwait(false);
            if (!hasRow)
            {
                // Draft was deleted; no matching row means conflict when an etag was expected.
                return null;
            }

            string storedEtag = currentReader.GetString(0);
            if (!string.Equals(storedEtag, expectedEtag, StringComparison.Ordinal))
            {
                return null;
            }
        }

        using (var updateReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE customization_draft
            SET version_id = @VersionId,
                payload = CAST(@Payload AS jsonb),
                etag = @Etag,
                updated_at_utc = @UpdatedAtUtc
            WHERE profile_id = @ProfileId
              AND etag = @ExpectedEtag
            RETURNING id, profile_id, version_id, payload::text, etag, updated_at_utc;
            """,
            new SugarParameter("@ProfileId", profileId),
            new SugarParameter("@VersionId", versionId is null ? DBNull.Value : versionId.Value),
            new SugarParameter("@Payload", payload),
            new SugarParameter("@Etag", newEtag),
            new SugarParameter("@ExpectedEtag", expectedEtag),
            new SugarParameter("@UpdatedAtUtc", updatedAtUtc)).ConfigureAwait(false))
        {
            if (!await updateReader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            return ReadDraft(updateReader);
        }
    }

    public async Task<IReadOnlyList<CustomizationChangeSet>> ListChangeSetsAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, profile_id, from_version_id, to_version_id, changes::text, created_at_utc
            FROM customization_change_set
            WHERE profile_id = @ProfileId
            ORDER BY id DESC;
            """,
            new SugarParameter("@ProfileId", profileId)).ConfigureAwait(false);

        var changeSets = new List<CustomizationChangeSet>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            changeSets.Add(ReadChangeSet(reader));
        }
        return changeSets.AsReadOnly();
    }

    public async Task<CustomizationChangeSet> CreateChangeSetAsync(
        long profileId,
        long fromVersionId,
        long toVersionId,
        string changes,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (fromVersionId == toVersionId)
        {
            throw new InvalidOperationException("fromVersionId and toVersionId must differ.");
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO customization_change_set (profile_id, from_version_id, to_version_id, changes, created_at_utc)
            VALUES (@ProfileId, @FromVersionId, @ToVersionId, CAST(@Changes AS jsonb), @CreatedAtUtc)
            RETURNING id, profile_id, from_version_id, to_version_id, changes::text, created_at_utc;
            """,
            new SugarParameter("@ProfileId", profileId),
            new SugarParameter("@FromVersionId", fromVersionId),
            new SugarParameter("@ToVersionId", toVersionId),
            new SugarParameter("@Changes", changes),
            new SugarParameter("@CreatedAtUtc", createdAtUtc)).ConfigureAwait(false);

        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        return ReadChangeSet(reader);
    }

    private static CustomizationProfile ReadProfile(DbDataReader reader)
        => new()
        {
            Id = reader.GetInt64(0),
            UserId = reader.GetInt32(1),
            Name = reader.GetString(2),
            CreatedAtUtc = ReadUtcDateTime(reader, 3),
            UpdatedAtUtc = ReadUtcDateTime(reader, 4)
        };

    private static CustomizationVersion ReadVersion(DbDataReader reader)
        => new()
        {
            Id = reader.GetInt64(0),
            ProfileId = reader.GetInt64(1),
            Version = reader.GetInt32(2),
            Payload = reader.GetString(3),
            CreatedAtUtc = ReadUtcDateTime(reader, 4)
        };

    private static CustomizationDraft ReadDraft(DbDataReader reader)
        => new()
        {
            Id = reader.GetInt64(0),
            ProfileId = reader.GetInt64(1),
            VersionId = reader.IsDBNull(2) ? null : reader.GetInt64(2),
            Payload = reader.GetString(3),
            Etag = reader.GetString(4),
            UpdatedAtUtc = ReadUtcDateTime(reader, 5)
        };

    private static CustomizationChangeSet ReadChangeSet(DbDataReader reader)
        => new()
        {
            Id = reader.GetInt64(0),
            ProfileId = reader.GetInt64(1),
            FromVersionId = reader.GetInt64(2),
            ToVersionId = reader.GetInt64(3),
            Changes = reader.GetString(4),
            CreatedAtUtc = ReadUtcDateTime(reader, 5)
        };

    private static DateTime ReadUtcDateTime(DbDataReader reader, int ordinal)
        => DateTime.SpecifyKind(reader.GetDateTime(ordinal), DateTimeKind.Utc);
}
