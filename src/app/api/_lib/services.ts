import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { getStorage } from "@/infrastructure/storage";
import { importLimitsFromEnv } from "@/modules/imports";

/** Lazily-resolved process-wide dependencies for route handlers. */
export const services = {
  db: () => getDb(),
  storage: () => getStorage(),
  env: () => getEnv(),
  importLimits: () => importLimitsFromEnv(getEnv()),
};
