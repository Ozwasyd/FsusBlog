ALTER TABLE public.article_body_insertion
    ALTER COLUMN offset_utf16 DROP NOT NULL,
    ALTER COLUMN length_utf16 DROP NOT NULL,
    ADD COLUMN edit_texts text[],
    ADD CHECK (cardinality(edit_texts) BETWEEN 1 AND 8),
    ADD CHECK (array_ndims(edit_texts) = 1),
    ADD CHECK (array_lower(edit_texts, 1) = 1),
    ADD CHECK (array_position(edit_texts, NULL::text) IS NULL);
