ALTER TABLE users ADD COLUMN company text CHECK (company IS NULL OR char_length(company) <= 150);
