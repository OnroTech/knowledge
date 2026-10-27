import { z } from "zod";
import { searchFiltersSchema, type SearchFilters } from "../shared/search-filters";

// Some providers make every property required when converting tool schemas to
// strict JSON Schema. Explicit nulls let the model express absent restrictions.
export const searchToolFiltersSchema = z.object({
  createdAfter: searchFiltersSchema.shape.createdAfter.nullable(),
  createdBefore: searchFiltersSchema.shape.createdBefore.nullable(),
  fileTypes: searchFiltersSchema.shape.fileTypes.nullable(),
  access: searchFiltersSchema.shape.access.nullable(),
  folderId: searchFiltersSchema.shape.folderId.nullable().describe(
    "An actual accessible folder ID only when the user requests that folder. Use null otherwise. Never use a document ID or a made-up placeholder ID. Attached documents already scope the search.",
  ),
}).strict();

export function normalizeSearchToolFilters(
  filters: z.infer<typeof searchToolFiltersSchema> | null | undefined,
): SearchFilters | undefined {
  if (filters == null) return undefined;
  return searchFiltersSchema.parse(Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== null),
  ));
}
