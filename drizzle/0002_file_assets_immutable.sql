-- Product principle P-1 / ADR-006: original file records are immutable.
-- Only storage_status, integrity_verified_at and updated_at may change after insert.
-- (created_by is excluded so that deleting a user can SET NULL it.)
CREATE OR REPLACE FUNCTION file_assets_guard_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'file_assets row % is immutable (only storage_status and integrity_verified_at may change)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER file_assets_immutable
  BEFORE UPDATE ON file_assets
  FOR EACH ROW EXECUTE FUNCTION file_assets_guard_immutable();
