This datasource reports the **content digest** of a GitHub release asset at a
fixed tag.

## Why it exists

Renovate can already follow a moving container tag (the `docker` datasource
resolves the digest of `:latest`) and a moving git ref (the `github-digest`
datasource resolves the commit behind a branch or tag). Neither covers a
release whose _tag stays the same_ while the uploaded bytes change — the
`tip` / `nightly` / `edge` pattern, where a release is re-published on every
upstream commit.

This datasource fills that gap by tracking the asset's digest, so a content
change drives an ordinary digest update.

## packageName format

`packageName` is the asset's own download URL:

```text
https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
```

for example:

```text
https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-macos-universal.zip
```

Encoding the URL directly keeps the dependency self-describing and lets callers
pass through the URL they already have, rather than splitting it into separate
repo/tag/asset fields.

## How it works

This is modelled exactly like a Docker `:latest` pin — the value is frozen and
the **digest** moves:

- `getReleases` reports the pinned tag as the only version. Combined with
  `exact` versioning (whose `isGreaterThan` is always `false`) no version update
  can ever be proposed; this exists so the dependency resolves a current version
  instead of being skipped as `invalid-value`.
- `getDigest` resolves the asset's current digest, so the update travels
  Renovate's **digest path**. That terminates naturally: once the new digest is
  written back, `currentDigest === newDigest` and the update is dropped.

Details:

- **API endpoint**: `{apiBaseUrl}repos/{owner}/{repo}/releases/tags/{tag}`
- **Default registryUrl**: `https://github.com`
- **Versioning**: `exact`

The matching asset is located by name and its `digest` field is returned. GitHub
only records `digest` for assets uploaded after it started tracking them; when
the field is absent — or the release 404s, which is routine for rolling
releases that CI deletes and recreates — the datasource returns `null` so
nothing is proposed.

Any other failure (rate limiting, 5xx, `ExternalHostError`) propagates rather
than being reported as "no digest". Swallowing those would cache a `null` for
the full TTL and hide a host problem the administrator can act on.

## Used by

The [`nix-update` manager](../../manager/nix-update/index.md) selects this
datasource automatically for packages whose `updateScript` passes
`--version=skip`, where the nix `version` attribute is deliberately frozen and
only the artifact's hash changes.
