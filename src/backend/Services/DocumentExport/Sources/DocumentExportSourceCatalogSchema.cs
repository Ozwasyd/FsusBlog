namespace FsusBlog.Server.Services.DocumentExport.Sources;

/// <summary>
/// Additive domain schema proposal. Registration and execution belong to the original migration authority.
/// No request, constructor or startup path executes this SQL.
/// </summary>
public static class DocumentExportSourceCatalogSchema
{
    public const string Sql = """
        CREATE TABLE document_export_source_catalog (
            source_version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (source_version > 0),
            choice_id varchar(64) NOT NULL UNIQUE CHECK (choice_id ~ '^[0-9a-f]{64}$'),
            owner_admin_principal_id bigint NOT NULL REFERENCES admin_principal(id) ON DELETE CASCADE,
            site_scope varchar(128) NOT NULL CHECK (length(btrim(site_scope)) > 0),
            source_kind integer NOT NULL CHECK (source_kind IN (1, 2, 3)),
            article_id integer NOT NULL CHECK (article_id > 0),
            draft_key varchar(96),
            revision_id bigint,
            publication_id bigint,
            fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
            UNIQUE (owner_admin_principal_id, site_scope, fingerprint),
            CHECK (
                (source_kind = 1 AND draft_key IS NOT NULL AND length(btrim(draft_key)) > 0
                    AND draft_key = btrim(draft_key) AND revision_id IS NULL AND publication_id IS NULL)
                OR (source_kind = 2 AND draft_key IS NULL AND revision_id IS NOT NULL
                    AND revision_id > 0 AND publication_id IS NULL)
                OR (source_kind = 3 AND draft_key IS NULL AND revision_id IS NOT NULL
                    AND revision_id > 0 AND publication_id IS NOT NULL AND publication_id > 0)
            )
        );
        """;
}
