DROP INDEX IF EXISTS "provider_user_model_cache_expiry_idx";--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" DROP CONSTRAINT IF EXISTS "provider_user_model_cache_credential_id_provider_credentials_id_fk";--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" DROP CONSTRAINT IF EXISTS "provider_user_model_cache_credential_id_fkey";--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" DROP CONSTRAINT IF EXISTS "provider_user_model_cache_user_provider_credential_pk";--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" DROP CONSTRAINT IF EXISTS "provider_user_model_cache_pkey";--> statement-breakpoint
DO $$
DECLARE
  existing_primary_key_name TEXT;
BEGIN
  SELECT conname INTO existing_primary_key_name
  FROM pg_constraint
  WHERE conrelid = 'provider_user_model_cache'::regclass
    AND contype = 'p';

  IF existing_primary_key_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE provider_user_model_cache DROP CONSTRAINT %I',
      existing_primary_key_name
    );
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" ALTER COLUMN "credential_id" TYPE TEXT USING "credential_id"::text;--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" ADD CONSTRAINT "provider_user_model_cache_user_provider_credential_pk" PRIMARY KEY("user_id","provider_id","credential_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_user_model_cache_expiry_idx" ON "provider_user_model_cache" USING btree ("expires_at");
