CREATE TABLE public.author_text_rebuild_job (
    owner_id uuid NOT NULL REFERENCES public.blog_user(id),
    profile integer NOT NULL CHECK (profile BETWEEN 1 AND 4),
    definition_id uuid NOT NULL,
    owner_generation bigint NOT NULL CHECK (owner_generation > 0),
    schema_revision bigint NOT NULL,
    definition_revision bigint NOT NULL CHECK (definition_revision >= 0),
    available_at timestamptz NOT NULL CHECK (isfinite(available_at)),
    CHECK (schema_revision >= definition_revision),
    PRIMARY KEY (owner_id, profile, definition_id),
    UNIQUE (available_at, owner_id, profile, definition_id)
);
