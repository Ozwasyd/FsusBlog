ALTER TABLE public.article_body_insertion
    ADD COLUMN operations integer[],
    ADD CHECK (cardinality(operations) BETWEEN 2 AND 16),
    ADD CHECK (array_ndims(operations) = 1),
    ADD CHECK (array_lower(operations, 1) = 1),
    ADD CHECK (array_position(operations, NULL::integer) IS NULL);
