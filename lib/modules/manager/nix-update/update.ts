import type { UpdateDependencyConfig } from '../types.ts';

export function updateDependency({
  fileContent,
}: UpdateDependencyConfig): string | null {
  // No-op: the fake '1' must never be written to any nix file.
  // nix-update in updateArtifacts handles the real version + hash updates.
  return fileContent;
}
