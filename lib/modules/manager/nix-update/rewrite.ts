import { logger } from '../../../logger/index.ts';
import { regEx } from '../../../util/regex.ts';
import type {
  RevRewriteContext,
  RewriteContext,
  UrlRewriteContext,
} from './types.ts';

// SRI/legacy hash literal pattern. SRI: sha256-<base64>=, sha512-..., sha1-...
// Legacy nix base32 is 52 chars [a-z0-9]; older files may also have hex sha256 (64 hex chars).
const hashLiteralRegex = regEx(
  /"(sha(?:256|512|1)-[A-Za-z0-9+/=]+|[a-z0-9]{52}|[A-Fa-f0-9]{64})"/,
);

// Match any of the hash attribute names on either side of the `=`.
// Keeps the leading whitespace + name + `=` so we re-emit it in the replacement.
const hashAttrLine = regEx(
  /(^|\s)(hash|sha256|sha512|sha1|outputHash)\s*=\s*"([^"]*)"/g,
);

// Match `url = "<value>"` inside a fetcher block. Used by rewriteUrl below.
const urlAttrLine = regEx(/(^|\s)(url)\s*=\s*"([^"]*)"/g);

// Match `rev = "<value>"` inside a fetcher block. Used by rewriteRev below.
const revAttrLine = regEx(/(^|\s)(rev)\s*=\s*"([^"]*)"/g);

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
  const anchor = attrPath.at(-1);
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
  const literals = [...content.matchAll(regEx(hashLiteralRegex, 'g'))];
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
    const fakeHashAttr = regEx(
      `(^|\\s)(${RegExp.escape(anchor)})\\s*=\\s*lib\\.fakeHash;`,
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

// Rewrite a `url = "..."` attribute in the .nix file. Mirrors rewriteHash:
// fast literal swap when oldUrl is unique, else contextual lookup via attrPath.
// Used when a customDatasource provides `downloadUrl` and the new URL's shape
// can't be derived from the old one by simple version interpolation (e.g.
// a per-release commit-hash segment).
export function rewriteUrl(content: string, ctx: UrlRewriteContext): string {
  const { attrPath, oldUrl, newUrl } = ctx;

  if (oldUrl === newUrl) {
    return content;
  }

  if (content.includes(oldUrl) && countOccurrences(content, oldUrl) === 1) {
    return content.replace(oldUrl, newUrl);
  }

  const anchor = attrPath.at(-1);
  if (!anchor) {
    throw new Error('rewriteUrl: empty attrPath');
  }

  const range = locateAttrRange(content, anchor);
  if (range) {
    const before = content.slice(0, range.start);
    const within = content.slice(range.start, range.end);
    const after = content.slice(range.end);
    // Replace exactly one binding. Prefer the one whose current value is
    // literally oldUrl; otherwise fall back to the first url attr in the
    // range — interpolated urls (e.g. "https://.../${version}/x.tar.gz")
    // never literally match the eval-resolved oldUrl.
    const matches = [...within.matchAll(urlAttrLine)];
    const target = matches.find((m) => m[3] === oldUrl) ?? matches[0];
    if (target) {
      const head = within.slice(0, target.index);
      const tail = within.slice(target.index + target[0].length);
      const updated = `${head}${target[1]}${target[2]} = "${newUrl}"${tail}`;
      return before + updated + after;
    }
  }

  throw new Error(
    `Could not locate url for attrPath ${attrPath.join('.')} in nix file`,
  );
}

// Rewrite a `rev = "..."` attribute in the .nix file.
//
// Branch-tracked packages (`--version=branch`) pin a literal commit sha that
// nothing else in this manager writes: `updateDependency` is a deliberate
// no-op for them (currentValue === newValue === the branch name) and
// `rewriteHash` only matches hash attributes. Without this the rewritten file
// would pair the freshly computed hash with the *previous* commit — a
// guaranteed fixed-output hash mismatch at build time.
//
// Mirrors rewriteHash/rewriteUrl: fast literal swap when oldRev is unique,
// else contextual lookup via attrPath. The fast path is what covers the
// `let rev = "..."; in ... { inherit rev; }` form, where the binding sits
// outside the src block and so is invisible to the contextual scan.
export function rewriteRev(content: string, ctx: RevRewriteContext): string {
  const { attrPath, oldRev, newRev } = ctx;

  if (oldRev === newRev) {
    return content;
  }

  if (content.includes(oldRev) && countOccurrences(content, oldRev) === 1) {
    return content.replace(oldRev, newRev);
  }

  const anchor = attrPath.at(-1);
  if (!anchor) {
    throw new Error('rewriteRev: empty attrPath');
  }

  const range = locateAttrRange(content, anchor);
  if (range) {
    const before = content.slice(0, range.start);
    const within = content.slice(range.start, range.end);
    const after = content.slice(range.end);
    // Prefer the binding whose current value is literally oldRev; otherwise
    // fall back to the first rev attr in the range — an interpolated rev
    // (e.g. "v${version}") never literally matches the eval-resolved oldRev.
    const matches = [...within.matchAll(revAttrLine)];
    const target = matches.find((m) => m[3] === oldRev) ?? matches[0];
    if (target) {
      const head = within.slice(0, target.index);
      const tail = within.slice(target.index + target[0].length);
      const updated = `${head}${target[1]}${target[2]} = "${newRev}"${tail}`;
      return before + updated + after;
    }
  }

  throw new Error(
    `Could not locate rev for attrPath ${attrPath.join('.')} in nix file`,
  );
}

// Match the date in a nixpkgs-style unstable version, e.g.
// `version = "0-unstable-2025-11-17"` or `version = "1.2.0-unstable-2026-06-30"`.
const unstableVersionLine = regEx(
  /(\bversion\s*=\s*"[^"]*-unstable-)(\d{4}-\d{2}-\d{2})(")/,
);

// Bump the date in a `-unstable-YYYY-MM-DD` version string.
//
// nixpkgs encodes the *commit date* of the pinned revision into the version of
// branch-tracked packages. `updateDependency` can't do this — for branch-tracked
// deps currentValue === newValue (the branch name), so it returns early — and
// the date isn't derivable from the commit sha, so it has to come from the
// datasource's release timestamp.
//
// Returns content unchanged when there's no unstable version string or the date
// already matches, so callers don't need to pre-check.
export function rewriteUnstableDate(content: string, newDate: string): string {
  const m = unstableVersionLine.exec(content);
  if (!m || m[2] === newDate) {
    return content;
  }
  return content.replace(unstableVersionLine, `$1${newDate}$3`);
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
  const bindingRegex = regEx(
    `(?:^|[\\s{(])${RegExp.escape(attrName)}\\s*=\\s*`,
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
