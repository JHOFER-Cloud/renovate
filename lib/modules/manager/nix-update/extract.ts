import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import { readLocalFile } from '../../../util/fs/index.ts';
import type { ExtractConfig, PackageFile } from '../types.ts';

// Nix expression passed to `nix eval .#packages --apply` to introspect all
// flake packages that have a passthru.updateScript. Returns a flat attrset of
// { attrName -> PackageInfo }. Kept as a template literal (rather than a
// separate .nix file) because the build/dist bundle only includes .ts files.
//
// NOTE: the \${sys} interpolation is literal Nix (not JS) — the backslash
// prevents JS template substitution so it reaches nix eval as ${sys}.
const evalExpr = `
pkgs:
builtins.foldl'
(acc: sys: let
  sysPkgs = pkgs.\${sys};
  /* FOD detection helpers. An FOD is a derivation with outputHash set —
     exactly the FODs nix-update would re-prefetch. Block-comment syntax
     because we collapse newlines below; # comments would consume the rest. */
  isFod = v:
    builtins.isAttrs v
    && (v.type or "") == "derivation"
    && v ? outputHash
    && v.outputHash != "";
  discardCtx = builtins.unsafeDiscardStringContext;
  /* Read the relevant fetcher inputs off a FOD derivation.
     All attrs are best-effort — null when missing. */
  fodInputs = drv:
    let
      maybe = a: if drv ? \${a} then discardCtx drv.\${a} else null;
      maybeBool = a: if drv ? \${a} then drv.\${a} else null;
      maybeListHead = a:
        if drv ? \${a} && builtins.isList drv.\${a} && builtins.length drv.\${a} > 0
        then discardCtx (builtins.head drv.\${a})
        else null;
    in {
      outputHash = discardCtx drv.outputHash;
      outputHashAlgo = drv.outputHashAlgo or "sha256";
      outputHashMode = drv.outputHashMode or "flat";
      url = if drv ? url then maybe "url" else maybeListHead "urls";
      rev = maybe "rev";
      fetchSubmodules = maybeBool "fetchSubmodules";
      leaveDotGit = maybeBool "leaveDotGit";
      deepClone = maybeBool "deepClone";
      forceFetchGit = maybeBool "forceFetchGit";
      sparseCheckout =
        if drv ? sparseCheckout && builtins.isList drv.sparseCheckout
        then map discardCtx drv.sparseCheckout
        else null;
      name = maybe "name";
    };
  /* Well-known FOD attribute names. Order matters: src first, then vendor
     FODs. If a package has more than one of these, each becomes a separate
     update. */
  fodAttrs = [
    "src" "goModules" "cargoDeps" "npmDeps" "pnpmDeps"
    "yarnOfflineCache" "offlineCache" "composerVendor"
    "composerRepository" "fetchedMavenDeps" "mixFodDeps"
    "zigDeps" "nugetDeps"
  ];
  collectFods = pkg:
    builtins.filter (x: x != null) (map (n:
      if pkg ? \${n} && isFod pkg.\${n}
      then { attrPath = [n]; inputs = fodInputs pkg.\${n}; }
      else null
    ) fodAttrs);
  entries = builtins.listToAttrs (builtins.concatMap (n:
    let p = sysPkgs.\${n};
    in if p ? passthru && p.passthru ? updateScript then [{ name = n; value =
      let
        us = p.passthru.updateScript;
        rawCmd =
          if builtins.isAttrs us && us ? command && builtins.isList us.command
          then us.command
          else if builtins.isList us
          then us
          else [];
        cmdLen = builtins.length rawCmd;
        cmdHead =
          if cmdLen > 0
          then discardCtx (builtins.head rawCmd)
          else "";
        isNixUpdateScript = builtins.match ".*nix-update.*" cmdHead != null;
        src = p.src or null;
        srcUrl =
          if src != null && builtins.isAttrs src
          then let
            u =
              if src ? urls && builtins.length src.urls > 0
              then builtins.head src.urls
              else src.url or null;
          in
            if u != null
            then discardCtx u
            else null
          else null;
        srcRev =
          if src != null && builtins.isAttrs src && src ? rev
          then discardCtx src.rev
          else null;
        /* meta.position points at the .nix file where the package is
           defined (e.g. /nix/store/<hash>-source/packages/foo/default.nix:25).
           We use it to give Renovate the *real* package file for each dep,
           so its auto-replace bumps the version in that file (instead of
           a no-op against flake.nix). */
        position =
          if p ? meta && p.meta ? position
          then p.meta.position
          else null;
      in {
        system = sys;
        version = p.version or null;
        pname = p.pname or null;
        inherit srcUrl srcRev position;
        updateScriptArgs =
          if isNixUpdateScript && cmdLen >= 2
          then
            map discardCtx
            (builtins.genList (i: builtins.elemAt rawCmd (i + 1)) (cmdLen - 1))
          else [];
        fods = collectFods p;
      }; }] else []
  ) (builtins.attrNames sysPkgs));
in
  acc // entries)
{}
(builtins.attrNames pkgs)
`;

// Raw fetcher inputs as they come back from the nix expression.
// Values are best-effort — most are null for any given fetcher type.
export interface FodInputs {
  outputHash: string;
  outputHashAlgo: string;
  outputHashMode: string;
  url: string | null;
  rev: string | null;
  fetchSubmodules: boolean | null;
  leaveDotGit: boolean | null;
  deepClone: boolean | null;
  forceFetchGit: boolean | null;
  sparseCheckout: string[] | null;
  name: string | null;
}

export interface FodInfo {
  // Path inside the package attrset, e.g. ["src"], ["goModules"], ["cargoDeps"]
  attrPath: string[];
  inputs: FodInputs;
}

interface PackageInfo {
  system: string;
  version: string | null;
  pname: string | null;
  srcUrl: string | null;
  srcRev: string | null;
  /* meta.position from nix eval — `<absPath>:<line>[:<col>]`. Used to derive
     the package file path Renovate should target for auto-replace. */
  position: string | null;
  updateScriptArgs: string[];
  fods: FodInfo[];
}

// Parse `meta.position` (`<storePathOrAbs>/<file.nix>:<line>[:<col>]`) into a
// relative path inside the flake. nix evaluates flakes from the store, so the
// position prefix is `/nix/store/<hash>-<name>/`; strip that to get the
// in-repo path. Returns null when position is missing or unparseable.
export function packageFileFromPosition(
  pos: string | null | undefined,
): string | null {
  if (!pos) {
    return null;
  }
  // Strip trailing :line[:col] — accept either form.
  const path = pos.replace(/(?::\d+)+$/, '');
  // Strip nix store prefix /nix/store/<32+hex>-<name>/
  const storeMatch = /^\/nix\/store\/[^/]+\/(.+)$/.exec(path);
  return storeMatch ? storeMatch[1] : path;
}

// nix-update accepts `--version-regex <pat>` to tell it which tags to consider.
// We translate that into Renovate's `extractVersion` (a regex with a named
// `version` capture group) so datasource lookups can parse prefixed tags
// like "ndcli-1.2.3" correctly.
export function deriveExtractVersion(args: string[]): string | undefined {
  const idx = args.indexOf('--version-regex');
  let pattern: string | undefined;
  if (idx >= 0 && idx + 1 < args.length) {
    pattern = args[idx + 1];
  } else {
    const eq = args.find((a) => a.startsWith('--version-regex='));
    pattern = eq ? eq.slice('--version-regex='.length) : undefined;
  }
  if (!pattern) {
    return undefined;
  }
  // Replace the first unnamed `(` with a named `(?<version>`. Leaves
  // non-capturing `(?:...)` and lookarounds alone.
  return pattern.replace(/\((?!\?)/, '(?<version>');
}

export function datasourceFromSrc(
  srcUrl: string | null,
  pname: string | null,
  updateScriptArgs: string[],
): { datasource: string; packageName: string } | null {
  if (!srcUrl) {
    return null;
  }

  // Strip .git suffix once, before any matching
  const cleanUrl = srcUrl.replace(/\.git$/, '');

  const isBranchTracked = updateScriptArgs.some((a) =>
    a.startsWith('--version=branch'),
  );

  // GitHub
  const ghMatch = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/|$)/.exec(
    cleanUrl,
  );
  if (ghMatch) {
    return isBranchTracked
      ? { datasource: 'github-digest', packageName: ghMatch[1] }
      : { datasource: 'github-tags', packageName: ghMatch[1] };
  }

  // GitLab
  const glMatch = /^https?:\/\/gitlab\.com\/([^/]+\/[^/]+?)(?:\/|$)/.exec(
    cleanUrl,
  );
  if (glMatch) {
    return { datasource: 'gitlab-tags', packageName: glMatch[1] };
  }

  // Bitbucket
  const bbMatch = /^https?:\/\/bitbucket\.org\/([^/]+\/[^/]+?)(?:\/|$)/.exec(
    cleanUrl,
  );
  if (bbMatch) {
    return { datasource: 'bitbucket-tags', packageName: bbMatch[1] };
  }

  // Codeberg (runs Forgejo)
  const codebergMatch =
    /^https?:\/\/codeberg\.org\/([^/]+\/[^/]+?)(?:\/|$)/.exec(cleanUrl);
  if (codebergMatch) {
    return { datasource: 'forgejo-tags', packageName: codebergMatch[1] };
  }

  // Gitea.com
  const giteaMatch = /^https?:\/\/gitea\.com\/([^/]+\/[^/]+?)(?:\/|$)/.exec(
    cleanUrl,
  );
  if (giteaMatch) {
    return { datasource: 'gitea-tags', packageName: giteaMatch[1] };
  }

  // SourceHut
  const srhtMatch = /^https?:\/\/git\.sr\.ht\/(~[^/]+\/[^/]+?)(?:\/|$)/.exec(
    cleanUrl,
  );
  if (srhtMatch) {
    return {
      datasource: 'git-tags',
      packageName: `https://git.sr.ht/${srhtMatch[1]}`,
    };
  }

  // Savannah (GNU + non-GNU)
  if (/savannah\.(gnu|nongnu)\.org/.test(cleanUrl)) {
    const base = cleanUrl.split('/archive/')[0].split('/download/')[0];
    return { datasource: 'git-tags', packageName: base };
  }

  // crates.io
  if (cleanUrl.includes('crates.io')) {
    return { datasource: 'crate', packageName: pname ?? '' };
  }

  // PyPI (mirror://pypi scheme or direct pythonhosted.org/pypi.io)
  if (
    /(?:^mirror:\/\/pypi\/)|(?:files\.pythonhosted\.org)|(?:pypi\.io)/.test(
      cleanUrl,
    )
  ) {
    return { datasource: 'pypi', packageName: pname ?? '' };
  }

  // RubyGems
  if (cleanUrl.includes('rubygems.org')) {
    return { datasource: 'rubygems', packageName: pname ?? '' };
  }

  // Generic git fallback — extract base repo URL (https://host/owner/repo)
  const genericMatch = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\/|$)/.exec(
    cleanUrl,
  );
  if (genericMatch) {
    return { datasource: 'git-tags', packageName: genericMatch[1] };
  }

  return null;
}

export async function extractAllPackageFiles(
  _config: ExtractConfig,
  files: string[],
): Promise<PackageFile[] | null> {
  // Phase 1: cheap pre-check — skip nix eval if no package uses nix-update-script
  const contents = await Promise.all(
    files.map((f) => readLocalFile(f, 'utf8')),
  );
  const hasNixUpdateScript = contents.some(
    (content) =>
      content && /passthru\.updateScript\s*=\s*nix-update-script/.test(content),
  );

  if (!hasNixUpdateScript) {
    return null;
  }

  // Phase 2: verify flake.nix exists (non-flake repos are out of scope)
  const flakeContent = await readLocalFile('flake.nix', 'utf8');
  if (!flakeContent) {
    logger.debug(
      'nix-update: nix-update-script found but no flake.nix — skipping',
    );
    return null;
  }

  // Phase 3: iterate every system in .#packages, recording which system each
  // package belongs to. Later systems overwrite earlier ones for cross-platform
  // packages (any system works). Per-system tracking lets us pass --system to
  // nix-update so it evaluates Linux-only packages on Linux and macOS-only
  // packages on macOS, regardless of which system renovate itself runs on.
  // Collapse to a single line before JSON.stringify — shell passes the
  // --apply value as-is, so literal \n from JSON escaping would break nix.
  const singleLineExpr = evalExpr.replace(/\n\s*/g, ' ').trim();
  const cmd =
    `nix --extra-experimental-features 'nix-command flakes' ` +
    `eval --json .#packages --apply ${JSON.stringify(singleLineExpr)}`;

  const execOptions: ExecOptions = {
    toolConstraints: [{ toolName: 'nix' }],
    docker: {},
  };

  let packageInfos: Record<string, PackageInfo>;
  try {
    const result = await exec(cmd, execOptions);
    const parsed: unknown = JSON.parse(result.stdout);
    /* v8 ignore next 8 -- defensive; nix eval always returns an attrset for the expression we run */
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      logger.debug(
        { stdout: result.stdout },
        'nix-update: nix eval returned non-object',
      );
      return null;
    }
    packageInfos = parsed as Record<string, PackageInfo>;
  } catch (err) {
    logger.debug({ err }, 'nix-update: failed to eval flake packages');
    return null;
  }

  const attrNames = Object.keys(packageInfos);
  if (!attrNames.length) {
    return null;
  }

  // Group deps by the source-file path each package was defined in
  // (from meta.position). Renovate's auto-replace then bumps the version in
  // that file, and our updateArtifacts receives the right newPackageFileContent.
  // Packages with no resolvable position fall back to flake.nix.
  const depsByFile = new Map<string, PackageFile['deps']>();
  const pushDep = (file: string, dep: PackageFile['deps'][number]): void => {
    const list = depsByFile.get(file) ?? [];
    list.push(dep);
    depsByFile.set(file, list);
  };

  for (const attrName of attrNames) {
    const info = packageInfos[attrName];
    const ds = datasourceFromSrc(
      info.srcUrl,
      info.pname,
      info.updateScriptArgs,
    );
    if (!ds) {
      logger.warn(
        { attrName, srcUrl: info.srcUrl },
        'nix-update: skipping — unsupported fetcher',
      );
      continue;
    }
    const isBranchTracked = info.updateScriptArgs.some((a) =>
      a.startsWith('--version=branch'),
    );
    const file = packageFileFromPosition(info.position) ?? 'flake.nix';

    if (isBranchTracked) {
      if (!info.srcRev) {
        logger.debug(
          { attrName },
          'nix-update: skipping branch-tracked — no src.rev to use as currentDigest',
        );
        continue;
      }
      // Parse explicit branch name from --version=branch:<name>; fall back to
      // 'main' (GitHub's modern default) when only --version=branch is given.
      const branchName =
        info.updateScriptArgs
          .map((a) => /^--version=branch:(.+)$/.exec(a)?.[1])
          .find(Boolean) ?? 'main';
      pushDep(file, {
        depName: attrName,
        datasource: ds.datasource, // 'github-digest'
        packageName: ds.packageName,
        currentValue: branchName,
        currentDigest: info.srcRev,
        versioning: 'exact',
        managerData: {
          attrName,
          system: info.system,
          pname: info.pname,
          updateScriptArgs: info.updateScriptArgs,
          isBranchTracked: true,
          fods: info.fods,
        },
      });
      continue;
    }

    if (!info.version) {
      logger.debug({ attrName }, 'nix-update: skipping — no version attribute');
      continue;
    }
    // If the package's nix-update-script passes --version-regex, repurpose
    // it as Renovate's `extractVersion` so tag-prefix patterns like
    // "ndcli-X.Y.Z" parse correctly. nix-update uses one capture group;
    // Renovate uses a named (?<version>...) group.
    const extractVersion = deriveExtractVersion(info.updateScriptArgs);
    pushDep(file, {
      depName: attrName,
      datasource: ds.datasource,
      packageName: ds.packageName,
      currentValue: info.version,
      versioning: 'loose',
      ...(extractVersion ? { extractVersion } : {}),
      managerData: {
        attrName,
        system: info.system,
        pname: info.pname,
        updateScriptArgs: info.updateScriptArgs,
        isBranchTracked: false,
        fods: info.fods,
      },
    });
  }

  if (!depsByFile.size) {
    return null;
  }

  return [...depsByFile.entries()].map(([packageFile, deps]) => ({
    packageFile,
    deps,
  }));
}
