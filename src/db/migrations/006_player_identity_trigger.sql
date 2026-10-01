-- Every player gets a permanent player code and a normalized name key
-- (lowercase, accents and punctuation removed) used for identity matching,
-- whichever code path created them.
CREATE OR REPLACE FUNCTION blst_name_key(first TEXT, last TEXT) RETURNS TEXT AS $$
  SELECT trim(regexp_replace(
           regexp_replace(lower(translate(coalesce(first, '') || ' ' || coalesce(last, ''),
             'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿ',
             'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyy')),
           '[^a-z ]', '', 'g'),
         '\s+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blst_players_identity() RETURNS trigger AS $$
BEGIN
  NEW.name_key := blst_name_key(NEW.first_name, NEW.last_name);
  IF NEW.player_code IS NULL THEN
    NEW.player_code := 'BLP-' || lpad(NEW.id::text, 6, '0');
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER players_identity BEFORE INSERT OR UPDATE OF first_name, last_name, player_code ON players
  FOR EACH ROW EXECUTE FUNCTION blst_players_identity();

UPDATE players SET name_key = blst_name_key(first_name, last_name);
