import { z } from 'zod/v4';
import { Nullish } from '../../../util/schema-utils/index.ts';
import { MaybeTimestamp } from '../../../util/timestamp.ts';

export const FlakeHubRelease = z.object({
  version: z.string(),
  simplified_version: z.string().optional(),
  revision: z.string(),
  commit_count: z.number().optional(),
  description: z.string().optional(),
  visibility: z.string().optional(),
  repo_url: z.string().optional(),
  source_subdirectory: Nullish(z.string()),
  mirrored: z.boolean().optional(),
  yanked_at: MaybeTimestamp.nullable(),
  readme: z.string().optional(),
  published_at: MaybeTimestamp,
  updated_at: MaybeTimestamp.optional(),
  index: z.number().optional(),
  total: z.number().optional(),
  download_url: z.string().optional(),
  pretty_download_url: z.string().optional(),
  created_at: MaybeTimestamp.optional(),
  source_github_owner_repo_pair: z.string().optional(),
  spdx_identifier: Nullish(z.string()),
});

export type FlakeHubRelease = z.infer<typeof FlakeHubRelease>;
