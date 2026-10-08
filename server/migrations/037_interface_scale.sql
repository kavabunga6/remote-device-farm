-- Interface scale: 0 means "automatic" (grows with the window, which is what 1.00 always did); any other value is a
-- fixed multiplier of 16 px. Existing 1.00 rows keep their behaviour by becoming 0.
ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_font_scale_check;
UPDATE user_preferences SET font_scale=0 WHERE font_scale=1.00;
ALTER TABLE user_preferences ALTER COLUMN font_scale SET DEFAULT 0;
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_font_scale_check CHECK (font_scale = 0 OR font_scale BETWEEN 0.80 AND 1.50);
