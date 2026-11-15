CREATE TABLE public.article_property_snapshot (
    article_id integer NOT NULL REFERENCES public.article(id),
    schema_revision bigint NOT NULL CHECK (schema_revision >= 0),
    value_revision bigint NOT NULL CHECK (value_revision >= 0),
    digest text NOT NULL CHECK (char_length(digest) = 64),
    field_digests text[] NOT NULL CHECK (cardinality(field_digests) <= 1000),
    PRIMARY KEY (article_id, schema_revision, value_revision)
);

CREATE TABLE public.article_property_snapshot_field (
    article_id integer NOT NULL,
    schema_revision bigint NOT NULL,
    value_revision bigint NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal > 0),
    definition_id uuid NOT NULL,
    machine_key text NOT NULL,
    definition_revision bigint NOT NULL CHECK (definition_revision > 0),
    definition_digest text NOT NULL CHECK (char_length(definition_digest) = 64),
    shape jsonb NOT NULL,
    data jsonb NOT NULL,
    references_ids integer[] NOT NULL CHECK (cardinality(references_ids) <= 32),
    PRIMARY KEY (article_id, schema_revision, value_revision, ordinal),
    UNIQUE (article_id, schema_revision, value_revision, machine_key),
    FOREIGN KEY (article_id, schema_revision, value_revision)
        REFERENCES public.article_property_snapshot(article_id, schema_revision, value_revision)
);

CREATE TABLE public.article_revision_property_snapshot (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    schema_revision bigint NOT NULL,
    value_revision bigint NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision(article_id, revision),
    FOREIGN KEY (article_id, schema_revision, value_revision)
        REFERENCES public.article_property_snapshot(article_id, schema_revision, value_revision)
);
