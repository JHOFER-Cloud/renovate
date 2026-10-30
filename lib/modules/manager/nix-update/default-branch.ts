import { getApiBaseUrl } from '../../../util/github/url.ts';
import { GithubHttp } from '../../../util/http/github.ts';
import { HttpError } from '../../../util/http/index.ts';
import { regEx } from '../../../util/regex.ts';
import { GithubDigestDatasource } from '../../datasource/github-digest/index.ts';

// The branch named in `--version=branch=<name>` (nix-update's own syntax) or
// `--version=branch:<name>` (accepted for configs written against the old
// parser), or null for a bare `--version=branch`.
export function explicitBranch(updateScriptArgs: string[]): string | null {
  for (const arg of updateScriptArgs) {
    const m = regEx(/^--version=branch[=:](?<branch>.+)$/).exec(arg);
    if (m) {
      return m[1];
    }
  }
  return null;
}

// A bare `--version=branch` follows the repository's default branch, as the
// nix-update CLI does. github-digest only resolves a *named* branch, so the
// name is looked up here. This lives in the manager rather than in the
// datasource on purpose: the datasource is upstream code, and teaching it a
// "no value means default branch" mode would conflict on every upstream sync.
//
// Same host type as github-digest, so the same host rules (token) apply. No
// package cache: one request per affected package per run, and GithubHttp
// already dedupes identical GETs within a run.
const http = new GithubHttp(GithubDigestDatasource.id);

// Resolves to null only for a repository that doesn't exist (404). Anything
// else — rate limiting, 5xx, auth — propagates: skipping the package on a
// transient error would drop its dependency and let Renovate autoclose its PR.
export async function getDefaultBranch(repo: string): Promise<string | null> {
  const url = `${getApiBaseUrl(undefined)}repos/${repo}`;
  try {
    const { body } = await http.getJsonUnchecked<{ default_branch?: string }>(
      url,
    );
    return body.default_branch ?? null;
  } catch (err) {
    if (err instanceof HttpError && err.response?.statusCode === 404) {
      return null;
    }
    throw err;
  }
}
