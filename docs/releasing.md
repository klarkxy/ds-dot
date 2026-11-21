# Publishing ds-dot

Publishing a GitHub Release runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) to check, build, and publish `ds-dot` to npm.

| Release kind | Version example | Target branch | GitHub Release | npm dist-tag |
|---|---|---|---|---|
| Stable | `0.3.0` | `main` | normal | `latest` |
| Prerelease | `0.3.0-rc.1` | `dev` (or `main`) | marked *pre-release* | `next` |

The release tag (`v<version>`), `package.json` `version`, GitHub *pre-release* flag, and branch must agree.

## Stable release

1. **Prepare on `dev`.** Open a PR into `dev` titled `release: prepare v0.3.0` that sets `package.json` `version` to `0.3.0`, and merge it with a merge commit.
2. **Open the release PR** from `dev` into `main`, titled `release: v0.3.0`. (`Release guard` requires `dev` to contain everything on `main` and `package.json` to have a higher stable version.)
3. **Merge with a merge commit**, the only merge method allowed on `main`.
4. **Publish.** In GitHub *Releases → Draft a new release*, create tag `v0.3.0` on `main`, click *Generate release notes*, and publish. Watch the **Publish to npm** workflow complete.
5. **Sync `main` back into `dev`.** Open a PR from `main` into `dev` titled `chore: sync main into dev` and merge it with a **merge commit** so the branches keep sharing history.

## Prerelease

Bump `package.json` `version` on `dev` (for example `0.3.0-rc.1`) through a normal PR, then publish a GitHub Release with tag `v0.3.0-rc.1` targeting `dev` and tick *Set as a pre-release*. This publishes to npm `next` without touching `latest`.

## Hotfix

1. Branch from `main`: `git switch main && git pull && git switch -c hotfix/short-name`.
2. Fix the issue and bump the patch version (`0.3.0` → `0.3.1`) on the same branch.
3. Open a PR into `main` titled `fix(scope): ...` and merge with a merge commit.
4. Publish a GitHub Release `v0.3.1` on `main`.
5. Sync `main` back into `dev` with a **merge commit** (step 5 under *Stable release*) before the next release PR from `dev`.

## Credentials and emergency publish

- **Token:** CI publishes with the repository's `NPM_TOKEN` Actions secret. If it expires or is revoked, replace it with a token able to publish `ds-dot` without an interactive two-factor prompt. Never commit the token.
- **Dry runs and reruns:** Trigger **Publish to npm** manually via *Actions* (`workflow_dispatch`) to verify checks and packing without publishing. Failed release runs can be rerun after fixing the cause. Published npm versions are immutable — fix a broken release with a new patch version.
- **Emergency local publish:** Run `pnpm typecheck && pnpm test && pnpm build` and inspect with `npm pack --dry-run --ignore-scripts`, then publish using an environment-backed npm config:

```ini
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
registry=https://registry.npmjs.org/
```

```sh
npm publish --access public --ignore-scripts
```

## Repository setup

Configure once in GitHub repository settings:

- **Rulesets:** Under *Settings → Rules → Rulesets → New ruleset → Import a ruleset*, import [`.github/rulesets/main.json`](../.github/rulesets/main.json) and [`.github/rulesets/dev.json`](../.github/rulesets/dev.json).
- **Pull Requests:** Under *Settings → General → Pull Requests*, enable *Allow merge commits* (default title: *Pull request title*, default message: *Blank*), disable *Allow squash merging* and *Allow rebase merging*, and enable *Automatically delete head branches*.
- **Default branch:** Keep `main` as the default branch so the repository opens on the latest published release.
- **Actions permissions:** Under *Settings → Actions → General*, keep *Workflow permissions* set to *Read repository contents*.
