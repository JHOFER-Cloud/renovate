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
  filtered =
    builtins.filterAttrs
    (n: p: p ? passthru && p.passthru ? updateScript)
    sysPkgs;
  entries =
    builtins.mapAttrs
    (n: p: let
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
        then builtins.unsafeDiscardStringContext (builtins.head rawCmd)
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
          then builtins.unsafeDiscardStringContext u
          else null
        else null;
      srcRev =
        if src != null && builtins.isAttrs src && src ? rev
        then builtins.unsafeDiscardStringContext src.rev
        else null;
    in {
      system = sys;
      version = p.version or null;
      pname = p.pname or null;
      inherit srcUrl srcRev;
      updateScriptArgs =
        if isNixUpdateScript && cmdLen >= 2
        then
          map builtins.unsafeDiscardStringContext
          (builtins.genList (i: builtins.elemAt rawCmd (i + 1)) (cmdLen - 1))
        else [];
    })
    filtered;
in
  acc // entries)
{}
(builtins.attrNames pkgs)
`;

interface PackageInfo {
  system: string;
  version: string | null;
  pname: string | null;
  srcUrl: string | null;
  srcRev: string | null;
  updateScriptArgs: string[];
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
  const cmd =
    `nix --extra-experimental-features 'nix-command flakes' ` +
    `eval --json .#packages --apply ${JSON.stringify(evalExpr)}`;

  const execOptions: ExecOptions = {
    toolConstraints: [{ toolName: 'nix' }],
    docker: {},
  };

  let packageInfos: Record<string, PackageInfo>;
  try {
    const result = await exec(cmd, execOptions);
    const parsed: unknown = JSON.parse(result.stdout);
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

  const deps = [];
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
      deps.push({
        depName: attrName,
        datasource: ds.datasource, // 'github-digest'
        packageName: ds.packageName,
        currentValue: branchName,
        currentDigest: info.srcRev,
        versioning: 'exact',
        managerData: {
          attrName,
          system: info.system,
          updateScriptArgs: info.updateScriptArgs,
          isBranchTracked: true,
        },
      });
      continue;
    }

    if (!info.version) {
      logger.debug({ attrName }, 'nix-update: skipping — no version attribute');
      continue;
    }
    deps.push({
      depName: attrName,
      datasource: ds.datasource,
      packageName: ds.packageName,
      currentValue: info.version,
      versioning: 'loose',
      managerData: {
        attrName,
        system: info.system,
        updateScriptArgs: info.updateScriptArgs,
        isBranchTracked: false,
      },
    });
  }

  if (!deps.length) {
    return null;
  }

  return [
    {
      packageFile: 'flake.nix',
      deps,
    },
  ];
}
