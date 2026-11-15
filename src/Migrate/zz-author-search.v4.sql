CREATE TABLE public.author_text_property_document (
    owner_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    article_id integer NOT NULL,
    definition_revision bigint NOT NULL CHECK (definition_revision > 0),
    value_revision bigint NOT NULL CHECK (value_revision > 0),
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    PRIMARY KEY (owner_id, definition_id, article_id),
    FOREIGN KEY (owner_id, definition_id) REFERENCES public.property_definition(owner_id, id),
    FOREIGN KEY (article_id, owner_id) REFERENCES public.property_article(article_id, owner_id)
);

CREATE TABLE public.author_text_property_posting (
    owner_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    article_id integer NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 16383),
    term bytea NOT NULL CHECK (octet_length(term) BETWEEN 1 AND 512),
    start_u16 integer NOT NULL CHECK (start_u16 >= 0),
    end_u16 integer NOT NULL CHECK (end_u16 <= 16384),
    start_u8 integer NOT NULL CHECK (start_u8 >= 0),
    end_u8 integer NOT NULL CHECK (end_u8 <= 65536),
    CHECK (start_u16 < end_u16),
    CHECK (start_u8 < end_u8),
    PRIMARY KEY (owner_id, definition_id, term, article_id, ordinal),
    UNIQUE (owner_id, definition_id, article_id, ordinal),
    FOREIGN KEY (owner_id, definition_id, article_id)
        REFERENCES public.author_text_property_document(owner_id, definition_id, article_id)
);
