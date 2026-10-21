import { z } from "zod";
import { CONTENT_KINDS, READING_STATUSES } from "@/infrastructure/database/schema";
import type { LibraryFilters } from "@/modules/artifacts/filters";

/** A real day Postgres accepts: zod's ISO date allows year 0000, which Postgres refuses. */
const day = z.iso.date().refine((value) => value >= "0001-01-01", "year must be 1 or later");

/** Query parameters of the library filters (API_CONTRACT §5, §7), validated once for all. */
export const FilterParams = {
  tag: z.uuid().optional(),
  project: z.uuid().optional(),
  collection: z.uuid().optional(),
  kind: z.enum(CONTENT_KINDS).optional(),
  // Exactly as recorded (not trimmed): the filter offers stored values, which keep spaces.
  model: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed")
    .optional(),
  from: day.optional(),
  to: day.optional(),
  /** `favorite=1` (or `true`): the actor's favorites. */
  favorite: z.enum(["1", "true"]).optional(),
  /** The actor's reading status; `unread` includes artifacts never opened. */
  status: z.enum(READING_STATUSES).optional(),
};

export function toFilters(query: {
  tag?: string;
  project?: string;
  collection?: string;
  kind?: string;
  model?: string;
  from?: string;
  to?: string;
  favorite?: string;
  status?: (typeof READING_STATUSES)[number];
}): LibraryFilters {
  return {
    tagId: query.tag,
    projectId: query.project,
    collectionId: query.collection,
    kind: query.kind,
    sourceModel: query.model,
    from: query.from,
    to: query.to,
    favorite: query.favorite ? true : undefined,
    readingStatus: query.status,
  };
}
