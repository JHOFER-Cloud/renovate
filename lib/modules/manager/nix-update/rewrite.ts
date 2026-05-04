import { logger } from '../../../logger/index.ts';
import { escapeRegExp, regEx } from '../../../util/regex.ts';

// SRI/legacy hash literal pattern. SRI: sha256-<base64>=, sha512-..., sha1-...
// Legacy nix base32 is 52 chars [a-z0-9]; older files may also have hex sha256 (64 hex chars).
const hashLiteralRegex = regEx(
  /"(sha(?:256|512|1)-[A-Za-z0-9+/=]+|[a-z0-9]{52}|[A-Fa-f0-9]{64})"/,
);

// Match any of the hash attribute names on either side of the `=`.
// Keeps the leading whitespace + name + `=` so we re-emit it in the replacement.
const hashAttrLine =
  /(^|\s)(hash|sha256|sha512|sha1|outputHash)\s*=\s*"([^"]*)"/g;

export interface RewriteContext {
  // Path of attributes from the package root down to the FOD.
  // E.g. ["src"], ["goModules"], ["passthru", "cargoDeps"].
  attrPath: string[];
  // Old hash currently in the file. Used as a sanity check + fallback.
  // Can be `null` for `lib.fakeHash` placeholders.
  oldHash: string | null;
  // New hash (SRI form, e.g. "sha256-...=").
  newHash: string;
}

// Rewrite a hash in the .nix file content. Strategy:
// 1. Locate the binding for the deepest attr in attrPath (e.g. "goModules =").
//    Scan forward from that point through balanced braces until we hit the
//    next sibling top-level binding or end of the file.
// 2. Within that range, replace the first hash attribute line with the new hash.
// 3. If the contextual approach fails AND the file contains exactly one hash
//    that matches `oldHash`, do a raw replacement.
// 4. If nothing matches, throw — caller turns this into an artifactError.
export function rewriteHash(content: string, ctx: RewriteContext): string {
  const { attrPath, oldHash, newHash } = ctx;

  if (oldHash && content.includes(oldHash)) {
    // Fast path: oldHash is unique in the file → safe to do a literal swap.
    const occurrences = countOccurrences(content, oldHash);
    if (occurrences === 1) {
      return content.replace(oldHash, newHash);
    }
  }

  // Contextual replacement. We need at least one attribute name in the path
  // to anchor the search.
  const anchor = attrPath[attrPath.length - 1];
  if (!anchor) {
    throw new Error('rewriteHash: empty attrPath');
  }

  const range = locateAttrRange(content, anchor);
  if (range) {
    const before = content.slice(0, range.start);
    const within = content.slice(range.start, range.end);
    const after = content.slice(range.end);
    const updated = within.replace(hashAttrLine, (_m, lead, name) => {
      return `${lead}${name} = "${newHash}"`;
    });
    if (updated !== within) {
      return before + updated + after;
    }
  }

  // Last resort: replace the first hash literal in the whole file.
  // Only safe when there's exactly one such literal.
  const literals = [...content.matchAll(new RegExp(hashLiteralRegex, 'g'))];
  if (literals.length === 1) {
    logger.debug(
      { attrPath, oldHash },
      'rewriteHash: falling back to single-literal replacement',
    );
    return content.replace(hashLiteralRegex, `"${newHash}"`);
  }

  // lib.fakeHash placeholder support — `<anyHashAttr> = lib.fakeHash;`
  // (no quotes). Use the attrPath's leaf as the anchor so we don't have to
  // enumerate every vendorHash/cargoHash/mvnHash etc.
  if (oldHash === null || oldHash === '' || oldHash === 'lib.fakeHash') {
    const fakeHashAttr = new RegExp(
      `(^|\\s)(${escapeRegExp(anchor)})\\s*=\\s*lib\\.fakeHash;`,
      'g',
    );
    const matches = [...content.matchAll(fakeHashAttr)];
    if (matches.length === 1) {
      return content.replace(fakeHashAttr, (_m, lead, name) => {
        return `${lead}${name} = "${newHash}";`;
      });
    }
  }

  throw new Error(
    `Could not locate hash for attrPath ${attrPath.join('.')} in nix file`,
  );
}

interface AttrRange {
  start: number;
  end: number;
}

// Find the source range of an attribute binding by name. Returns the byte
// offsets of the value expression — from after `<name> =` to the matching `;`.
// Handles nested braces. Comments containing `;` or braces will confuse this
// but those are vanishingly rare in nixpkgs-style packaging files.
function locateAttrRange(content: string, attrName: string): AttrRange | null {
  // Match the attr binding. Anchored: must be at start or after whitespace/{
  // so we don't match inside identifiers (e.g. `goModules` should not match
  // an attr called `someGoModules`).
  const bindingRegex = new RegExp(
    `(?:^|[\\s{(])${escapeRegExp(attrName)}\\s*=\\s*`,
    'g',
  );
  const m = bindingRegex.exec(content);
  if (!m) {
    return null;
  }
  const valueStart = m.index + m[0].length;

  // Walk forward, tracking brace depth and string state, until the matching
  // top-level `;` for this binding.
  let depth = 0;
  let inString = false;
  let inIndentString = false;
  let i = valueStart;
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];

    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (inIndentString) {
      // ''<text>'' indented strings — `''` ends them (but `'''` is escape)
      if (c === "'" && next === "'") {
        if (content[i + 2] === "'") {
          i += 3;
          continue;
        }
        inIndentString = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      i++;
      continue;
    }
    if (c === "'" && next === "'") {
      inIndentString = true;
      i += 2;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      i++;
      continue;
    }
    if (c === ';' && depth === 0) {
      return { start: valueStart, end: i };
    }
    i++;
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
