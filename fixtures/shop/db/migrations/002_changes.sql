-- shrink the table
ALTER TABLE orders DROP COLUMN legacy_ref;
ALTER TABLE orders ADD COLUMN region TEXT NOT NULL;
