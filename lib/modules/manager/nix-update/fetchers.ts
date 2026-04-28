import { regEx } from '../../../util/regex.ts';
import {
  type FetcherInputs,
  type HashAlgo,
  type VendorInputs,
  exprForCargoDeps,
  exprForComposerVendor,
  exprForGoModules,
  exprForMavenDeps,
  exprForMixFodDeps,
  exprForNpmDeps,
  exprForNuGetDeps,
  exprForPnpmDeps,
  exprForSrcFetcher,
  exprForYarnDeps,
  exprForZigDeps,
} from './expr.ts';
import type { FodInfo } from './extract.ts';

// Result of classifying a FOD: which builder to use, plus the inputs we need
// to feed back into the runner-side rebuild.
export interface ClassifiedFod {
  // attrPath inside the package, used by rewrite.ts to locate the hash
  attrPath: string[];
  // hash currently in the file (so rewrite can find/replace it; null = lib.fakeHash)
  currentHash: string | null;
  // hash algorithm — preserved through the rebuild
  algo: HashAlgo;
  // for ordering: src fetchers run first, vendor builders second
  isSrc: boolean;
  // a function that, given the runner-side srcExpr (used by vendor builders)
  // and the package's flake path, returns the nix expression to nix-build.
  // For src fetchers, srcExpr is unused.
  buildExpr: (flakePath: string, srcExpr: string) => string;
  // detected fetcher name (debug/error messaging only)
  fetcherName: string;
}

// Classify a FOD entry coming out of extract.ts. Throws if we can't recognize it.
export function classifyFod(
  fod: FodInfo,
  pkgPname: string | null,
  pkgVersion: string | null,
): ClassifiedFod {
  const algo = normalizeAlgo(fod.inputs.outputHashAlgo);
  const currentHash = fod.inputs.outputHash || null;
  const attr = fod.attrPath[fod.attrPath.length - 1];

  // Vendor / dep FODs identified by attribute name.
  if (attr !== 'src') {
    const v: VendorInputs = {
      pname: pkgPname ?? attr,
      version: pkgVersion ?? '0',
      // srcExpr is the runner-side src fetcher call — passed in by the caller
      srcExpr: '',
    };
    switch (attr) {
      case 'goModules':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'goModules',
          buildExpr: (flakePath, srcExpr) =>
            exprForGoModules(flakePath, { ...v, srcExpr }, algo),
        };
      case 'cargoDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'cargoDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForCargoDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'npmDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'npmDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForNpmDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'pnpmDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'pnpmDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForPnpmDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'yarnOfflineCache':
      case 'offlineCache':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: attr,
          buildExpr: (flakePath, srcExpr) =>
            exprForYarnDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'composerVendor':
      case 'composerRepository':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: attr,
          buildExpr: (flakePath, srcExpr) =>
            exprForComposerVendor(flakePath, { ...v, srcExpr }, algo),
        };
      case 'fetchedMavenDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'fetchedMavenDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForMavenDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'mixFodDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'mixFodDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForMixFodDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'nugetDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'nugetDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForNuGetDeps(flakePath, { ...v, srcExpr }, algo),
        };
      case 'zigDeps':
        return {
          attrPath: fod.attrPath,
          currentHash,
          algo,
          isSrc: false,
          fetcherName: 'zigDeps',
          buildExpr: (flakePath, srcExpr) =>
            exprForZigDeps(flakePath, { ...v, srcExpr }, algo),
        };
      default:
        throw new Error(
          `Unsupported vendor FOD attribute: ${fod.attrPath.join('.')}`,
        );
    }
  }

  // src — classify by URL pattern + hashMode.
  const fetcher = classifySrcFetcher(fod);
  const srcInputs = buildSrcInputs(fetcher, fod);

  return {
    attrPath: fod.attrPath,
    currentHash,
    algo,
    isSrc: true,
    fetcherName: fetcher,
    buildExpr: (flakePath) =>
      exprForSrcFetcher(flakePath, fetcher, srcInputs, algo),
  };
}

// Public helper: build the runner-side src fetcher expression for use as
// the `srcExpr` in vendor-FOD rebuilds. The hash here is the *known* hash
// from a successful src prefetch — no longer a placeholder.
export function buildKnownSrcExpr(
  fod: FodInfo,
  knownHash: string,
  flakePath: string,
): string {
  const fetcher = classifySrcFetcher(fod);
  const inputs = buildSrcInputs(fetcher, fod);
  // exprForSrcFetcher emits a placeholder; we splice in the real hash.
  // (Cheaper than threading the hash through every builder signature.)
  const placeholder = exprForSrcFetcher(
    flakePath,
    fetcher,
    inputs,
    normalizeAlgo(fod.inputs.outputHashAlgo),
  );
  return placeholder.replace(
    /hash = "sha(?:256|512|1)-[A-Za-z0-9+/=]+"/,
    `hash = "${knownHash}"`,
  );
}

// ---------- internals ----------

const githubArchiveRegex = regEx(
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/archive\/[^/]+\.(?:tar\.gz|zip)$/,
);
// GitLab archive URLs come in two flavours: the browser-facing
// /-/archive/<rev>/<repo>-<rev>.tar.gz and the API
// /api/v4/projects/<id>/repository/archive.<ext>?sha=<rev>.
const gitlabArchiveRegex = regEx(
  /^https?:\/\/gitlab\.com\/(?:[^/]+\/[^/]+\/-\/archive\/|api\/v4\/projects\/[^/]+\/repository\/archive)/,
);
const giteaArchiveRegex = regEx(
  /^https?:\/\/[^/]*gitea[^/]*\/[^/]+\/[^/]+\/archive\/[^/]+\.(?:tar\.gz|zip)$/,
);
const bitbucketArchiveRegex = regEx(
  /^https?:\/\/bitbucket\.org\/[^/]+\/[^/]+\/get\/[^/]+\.(?:tar\.gz|zip)$/,
);
const sourcehutArchiveRegex = regEx(
  /^https?:\/\/git\.sr\.ht\/~[^/]+\/[^/]+\/archive\/[^/]+\.(?:tar\.gz|zip)$/,
);
const pypiUrlRegex = regEx(/(?:files\.pythonhosted\.org|pypi\.io|pypi\.org)/);
const cratesUrlRegex = regEx(/crates\.io\/api\/v1\/crates\//);
const rubygemsUrlRegex = regEx(/rubygems\.org\/(?:gems|downloads)\//);
const vcsProtocolRegex = regEx(/^(?:git|hg|svn)\+|\.git$/);

function classifySrcFetcher(fod: FodInfo): string {
  const { url, outputHashMode } = fod.inputs;
  if (!url) {
    // Defensive: extract.ts only emits FodInfo with url=null for vendor FODs
    // (goModules/cargoDeps/etc.), and those don't reach this function.
    /* v8 ignore next */
    return 'fetchurl';
  }

  // Explicit git/hg/svn protocol — fetchgit/fetchhg/fetchsvn. The presence
  // of a `rev` attribute does NOT discriminate, because fetchFromGitHub
  // also passes rev through as a passthrough attribute on its derivation.
  if (vcsProtocolRegex.test(url)) {
    if (url.startsWith('hg+')) {
      return 'fetchhg';
    }
    if (url.startsWith('svn+')) {
      return 'fetchsvn';
    }
    return 'fetchgit';
  }

  // Forge-specific archive URLs — fetchFromGitHub etc. construct these.
  if (githubArchiveRegex.test(url)) {
    return 'fetchFromGitHub';
  }
  if (gitlabArchiveRegex.test(url)) {
    return 'fetchFromGitLab';
  }
  if (giteaArchiveRegex.test(url)) {
    return 'fetchFromGitea';
  }
  if (bitbucketArchiveRegex.test(url)) {
    return 'fetchFromBitbucket';
  }
  if (sourcehutArchiveRegex.test(url)) {
    return 'fetchFromSourcehut';
  }

  // Registry tarballs.
  if (pypiUrlRegex.test(url)) {
    return 'fetchPypi';
  }
  if (cratesUrlRegex.test(url)) {
    return 'fetchCrate';
  }
  if (rubygemsUrlRegex.test(url)) {
    return 'fetchgem';
  }

  // Fallback: generic URL fetcher. fetchzip if recursive (unpacks),
  // fetchurl if flat.
  if (outputHashMode === 'recursive') {
    return 'fetchzip';
  }
  return 'fetchurl';
}

function buildSrcInputs(fetcher: string, fod: FodInfo): FetcherInputs {
  const {
    url,
    rev,
    fetchSubmodules,
    leaveDotGit,
    deepClone,
    sparseCheckout,
    name,
  } = fod.inputs;
  switch (fetcher) {
    case 'fetchFromGitHub':
    case 'fetchFromGitLab':
    case 'fetchFromGitea':
    case 'fetchFromBitbucket':
    case 'fetchFromSourcehut':
    case 'fetchFromRepoOrCz': {
      // Parse owner/repo/rev from the archive URL.
      const parsed = parseArchiveUrl(url ?? '', fetcher);
      if (!parsed) {
        throw new Error(`Could not parse ${fetcher} URL: ${url}`);
      }
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        rev: parsed.rev,
        ...(fetchSubmodules !== null && { fetchSubmodules: !!fetchSubmodules }),
        ...(leaveDotGit !== null && { leaveDotGit: !!leaveDotGit }),
      };
    }
    case 'fetchgit':
    case 'fetchhg':
    case 'fetchsvn':
    case 'fetchfossil':
      return {
        url: url ?? undefined,
        rev: rev ?? undefined,
        ...(fetchSubmodules !== null && { fetchSubmodules: !!fetchSubmodules }),
        ...(leaveDotGit !== null && { leaveDotGit: !!leaveDotGit }),
        ...(deepClone !== null && { deepClone: !!deepClone }),
        ...(sparseCheckout && { sparseCheckout }),
      };
    case 'fetchPypi':
    case 'fetchCrate':
    case 'fetchgem': {
      // Parse pname/version from the URL.
      const parsed = parseRegistryUrl(url ?? '', fetcher);
      if (!parsed) {
        throw new Error(`Could not parse ${fetcher} URL: ${url}`);
      }
      return parsed;
    }
    case 'fetchurl':
    case 'fetchTarball':
    case 'fetchzip':
    default:
      return {
        url: url ?? undefined,
        ...(name && { name }),
      };
  }
}

interface ParsedArchive {
  owner: string;
  repo: string;
  rev: string;
}

function parseArchiveUrl(url: string, fetcher: string): ParsedArchive | null {
  switch (fetcher) {
    case 'fetchFromGitHub': {
      const m = regEx(
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/([^/]+)\.(?:tar\.gz|zip)$/,
      ).exec(url);
      return m ? { owner: m[1], repo: m[2], rev: m[3] } : null;
    }
    case 'fetchFromGitea': {
      const m = regEx(
        /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/archive\/([^/]+)\.(?:tar\.gz|zip)$/,
      ).exec(url);
      return m ? { owner: m[1], repo: m[2], rev: m[3] } : null;
    }
    case 'fetchFromBitbucket': {
      const m = regEx(
        /^https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/get\/([^/]+)\.(?:tar\.gz|zip)$/,
      ).exec(url);
      return m ? { owner: m[1], repo: m[2], rev: m[3] } : null;
    }
    case 'fetchFromSourcehut': {
      const m = regEx(
        /^https?:\/\/git\.sr\.ht\/(~[^/]+)\/([^/]+)\/archive\/([^/]+)\.(?:tar\.gz|zip)$/,
      ).exec(url);
      return m ? { owner: m[1], repo: m[2], rev: m[3] } : null;
    }
    case 'fetchFromGitLab':
    default:
      // GitLab archive URLs encode owner/repo/rev in query params; without
      // those passthrough attrs we can't reliably reconstruct. Caller can
      // still fall back to fetchzip on the raw URL.
      return null;
  }
}

function parseRegistryUrl(url: string, fetcher: string): FetcherInputs | null {
  switch (fetcher) {
    case 'fetchPypi': {
      // https://files.pythonhosted.org/packages/source/<x>/<pname>/<pname>-<version>.tar.gz
      const m = regEx(
        /\/([^/]+)\/([^/]+)-([0-9][^/]*)\.(tar\.gz|tar\.bz2|tar\.xz|zip|whl)$/,
      ).exec(url);
      return m ? { pname: m[2], version: m[3], extension: m[4] } : null;
    }
    case 'fetchCrate': {
      // https://crates.io/api/v1/crates/<pname>/<version>/download
      const m = regEx(/\/crates\/([^/]+)\/([^/]+)\/download/).exec(url);
      return m ? { pname: m[1], version: m[2] } : null;
    }
    case 'fetchgem': {
      const m = regEx(/\/([^/]+)-([^/]+)\.gem$/).exec(url);
      return m ? { pname: m[1], version: m[2] } : null;
    }
    default:
      // defensive; only registry fetchers reach this dispatch
      /* v8 ignore next */
      return null;
  }
}

function normalizeAlgo(a: string | undefined): HashAlgo {
  if (a === 'sha512' || a === 'sha1') {
    return a;
  }
  return 'sha256';
}
