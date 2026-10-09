namespace FsusBlog.Migration.Definitions;

/// <summary>Unregistered Expand definition; registration and schema products remain migration-owned.</summary>
internal static class ArticleRelationSourceCoordinateMigrationDefinitions
{
    internal const string MigrationId = "20261009-post-article-relation-source-coordinate";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Persist canonical portable article and immutable revision/source incarnation coordinates.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps: [new RawSqlStep(Sql)]);

    internal const string Sql = """
        CREATE TABLE IF NOT EXISTS article_relation_article_binding (
            article_id integer PRIMARY KEY REFERENCES article(id) ON DELETE RESTRICT,
            portable_identity uuid NOT NULL,
            CONSTRAINT ux_article_relation_article_identity UNIQUE (portable_identity),
            CONSTRAINT ck_article_relation_article_identity CHECK (
                portable_identity <> '00000000-0000-0000-0000-000000000000'::uuid)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_article_revision_coordinate_owner
            ON article_revision(article_id, id);
        CREATE TABLE IF NOT EXISTS article_relation_source_coordinate (
            revision_id bigint PRIMARY KEY,
            article_id integer NOT NULL REFERENCES article_relation_article_binding(article_id) ON DELETE RESTRICT,
            revision_identity uuid NOT NULL,
            source_epoch uuid NOT NULL,
            CONSTRAINT fk_article_relation_source_owner FOREIGN KEY (article_id, revision_id)
                REFERENCES article_revision(article_id, id) ON DELETE RESTRICT,
            CONSTRAINT ux_article_relation_revision_identity UNIQUE (revision_identity),
            CONSTRAINT ux_article_relation_source_epoch UNIQUE (source_epoch),
            CONSTRAINT ck_article_relation_revision_identity CHECK (
                revision_identity <> '00000000-0000-0000-0000-000000000000'::uuid),
            CONSTRAINT ck_article_relation_source_epoch CHECK (
                source_epoch <> '00000000-0000-0000-0000-000000000000'::uuid)
        );
        CREATE OR REPLACE FUNCTION article_relation_coordinate_refuse_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'article_relation_coordinate_immutable';
        END;
        $function$;
        CREATE OR REPLACE TRIGGER article_relation_article_binding_immutable
            BEFORE UPDATE OR DELETE ON article_relation_article_binding
            FOR EACH ROW EXECUTE FUNCTION article_relation_coordinate_refuse_mutation();
        CREATE OR REPLACE TRIGGER article_relation_source_coordinate_immutable
            BEFORE UPDATE OR DELETE ON article_relation_source_coordinate
            FOR EACH ROW EXECUTE FUNCTION article_relation_coordinate_refuse_mutation();
        """;
}
