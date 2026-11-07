-- Storage rejects '~' in object keys ("Invalid key"), and ids are part of those keys. Generated ids switch to
-- "!<uuid>": '!' is accepted by storage and, like '~', is not a valid character in a document name, so a generated
-- id can never equal a path. Nothing was ever stored under a '~' key (those uploads failed), so only the rows change;
-- the desktop app maps '~' ids it still has on disk to the new form.
update documents set id = '!' || substr(id, 2) where id like '~%';
update templates set id = '!' || substr(id, 2) where id like '~%';
alter table documents alter column id set default ('!' || gen_random_uuid()::text);
alter table templates alter column id set default ('!' || gen_random_uuid()::text);
