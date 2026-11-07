-- Documents, folders and templates get a stable identity, so a rename or move is an UPDATE of `path`
-- instead of a delete plus a create.
--
-- `id` is also the key under which a document's images and preview live in the `project-files` bucket
-- ("<user_id>/<id>/images/…", "<user_id>/<id>/preview.png", "<user_id>/.templates/<id>/preview.png"),
-- so renaming never touches storage. Existing rows keep their storage location by taking their current
-- path as id. New rows get "~<uuid>": '~' is not a valid character in a name, so a generated id can never
-- equal a path.

alter table documents add column id text;
alter table templates add column id text;
update documents set id = path;
update templates set id = path;

alter table documents alter column id set not null;
alter table documents alter column id set default ('~' || gen_random_uuid()::text);
alter table templates alter column id set not null;
alter table templates alter column id set default ('~' || gen_random_uuid()::text);

-- (user_id, path) used to be the primary key. Path is now just a name, unique among live rows;
-- soft-deleted rows may share one with a live row.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'documents'::regclass and contype = 'p' loop
    execute format('alter table documents drop constraint %I', c);
  end loop;
  for c in select conname from pg_constraint where conrelid = 'templates'::regclass and contype = 'p' loop
    execute format('alter table templates drop constraint %I', c);
  end loop;
end $$;

alter table documents add primary key (user_id, id);
alter table templates add primary key (user_id, id);
create unique index documents_live_path on documents (user_id, path) where deleted_at is null;
create unique index templates_live_path on templates (user_id, path) where deleted_at is null;

-- A rename must move the version too, so other devices notice it. (Setting preview_at still must not.)
create or replace function touch_document() returns trigger language plpgsql as $$
begin
  if new.source is distinct from old.source
     or new.path is distinct from old.path
     or new.deleted_at is distinct from old.deleted_at
     or new.kind is distinct from old.kind then
    new.updated_at = now();
  end if;
  return new;
end $$;

create or replace function touch_template() returns trigger language plpgsql as $$
begin
  if new.source is distinct from old.source
     or new.path is distinct from old.path
     or new.deleted_at is distinct from old.deleted_at then
    new.updated_at = now();
  end if;
  return new;
end $$;
