import { escapeRegExp, regEx } from '../../../util/regex.ts';
import type { UpdateDependencyConfig } from '../types.ts';

// Bump the package's `version = "<currentValue>"` line to the new value.
// We must do this here (rather than relying on Renovate's `doAutoReplace`)
// because Renovate skips auto-replace when a manager defines its own
// `updateDependency`. Hashes are still handled in `updateArtifacts` via the
// runner-side prefetch — this function is *only* about the version line.
//
// Branch-tracked packages (`--version=branch`) keep `currentValue ===
// newValue` (the branch name), so this is a no-op for them; their version
// attribute typically encodes a date string we don't have.
export function updateDependency({
  fileContent,
  upgrade,
}: UpdateDependencyConfig): string | null {
  const { currentValue } = upgrade;
  // Prefer newValue (datasource-normalised, no `v` prefix) over newVersion
  // (raw tag — may include the prefix and produce `version = "v1.2.3"`).
  const newValue = upgrade.newValue ?? upgrade.newVersion;
  if (!currentValue || !newValue || currentValue === newValue) {
    return fileContent;
  }
  // Match `version = "<currentValue>"` (any whitespace), case-sensitive.
  // We anchor on `\bversion\s*=\s*` so unrelated `*Version` attrs aren't hit.
  const versionLine = regEx(
    `(\\bversion\\s*=\\s*)"${escapeRegExp(currentValue)}"`,
  );
  if (!versionLine.test(fileContent)) {
    // File doesn't contain the expected `version = "<currentValue>"` —
    // could be: (a) we're re-running on an already-bumped branch, or
    // (b) the package puts version somewhere unusual. In both cases,
    // returning fileContent unchanged is safe — updateArtifacts handles
    // the rest, and Renovate's "no content changed" path falls through
    // to the nix-update special-case in get-updated.ts.
    return fileContent;
  }
  return fileContent.replace(versionLine, `$1"${newValue}"`);
}
