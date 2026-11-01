-- Photos can now be "used" (imported, kept for re-inserting) and "trashed" (undoable delete, purged by the
-- desktop app after a week). The phone only ever inserts 'pending' rows, so it is unaffected.
alter table photos add column imported_at timestamptz;
alter table photos add column trashed_at timestamptz;

alter table photos drop constraint photos_status_check;
alter table photos add constraint photos_status_check check (status in ('pending', 'imported', 'trashed'));
