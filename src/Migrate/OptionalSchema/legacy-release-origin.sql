CREATE TABLE public.legacy_release_origin (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    publication_id bigint NOT NULL UNIQUE,
    source_revision_id bigint NOT NULL,
    source_actor_id bigint NOT NULL,
    source_rollback_revision_id bigint,
    rollback_reason text,
    responsibility jsonb,
    evidence jsonb NOT NULL,
    manifest jsonb NOT NULL,
    plan_sha256 text NOT NULL,
    projection_sha256 text NOT NULL,
    source_admin_identity_sha256 text NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision)
);
