ALTER TABLE public.author_text_document
    DROP CONSTRAINT author_text_document_profile_check,
    ADD CONSTRAINT author_text_document_profile_check CHECK (profile BETWEEN 1 AND 3);

ALTER TABLE public.author_text_posting
    ADD COLUMN segment int NOT NULL DEFAULT 0,
    DROP CONSTRAINT author_text_posting_field_check,
    ADD CONSTRAINT author_text_posting_field_check CHECK (field BETWEEN 1 AND 4),
    ADD CONSTRAINT author_text_posting_segment_check
        CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0);
