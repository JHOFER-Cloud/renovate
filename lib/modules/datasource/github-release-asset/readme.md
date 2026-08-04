This datasource reports the **content digest** of a GitHub release asset at a
fixed tag.

## Why it exists

Renovate can already follow a moving container tag (the `docker` datasource
resolves the digest of `:latest`) and a moving git ref (the `github-digest`
datasource resolves the commit behind a branch or tag). Neither covers a
release whose _tag stays the same_ while the uploaded bytes change — the
`tip` / `nightly` / `edge` pattern, where a release is re-published on every
upstream commit.

This datasource fills that gap: it returns the asset's digest as the version,
so a content change surfaces as an ordinary version change and drives a normal
update.

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

- **API endpoint**: `{apiBaseUrl}repos/{owner}/{repo}/releases/tags/{tag}`
- **Default registryUrl**: `https://github.com`
- **Versioning**: `exact` — digests are opaque strings, compared for equality

The matching asset is located by name and its `digest` field is returned as the
sole release. GitHub only records `digest` for assets uploaded after it started
tracking them; when the field is absent the datasource returns `null` so nothing
is proposed.

## Used by

The [`nix-update` manager](../../manager/nix-update/index.md) selects this
datasource automatically for packages whose `updateScript` passes
`--version=skip`, where the nix `version` attribute is deliberately frozen and
only the artifact's hash changes.
