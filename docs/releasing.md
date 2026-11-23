# Publishing ds-dot

Publishing a GitHub Release triggers [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) to verify, build, pack, and publish `ds-dot` to npm.

| Release kind | Version example | Target branch | GitHub Release | npm dist-tag |
|---|---|---|---|---|
| **Stable** | `0.3.0` | `main` | normal | `latest` |
| **Prerelease** | `0.3.0-rc.1` | `dev` (or `main`) | marked *pre-release* | `next` |

The release tag (`v<version>`), `package.json` `version`, GitHub *pre-release* checkbox, and target branch must all match.

---

## Stable release

1. **Prepare on `dev`:** Open a PR into `dev` titled `release: prepare v0.3.0` that bumps `package.json` `version` to `0.3.0` and confirms all release features are synced into Dorothy's blog (`docs/`, via [`.agents/skills/ds-dot-blog/`](../.agents/skills/ds-dot-blog/SKILL.md)), the slim READMEs, and [`reference.md`](reference.md) before merging with a **merge commit**.
2. **Open the release PR:** Create a PR from `dev` into `main` titled `release: v0.3.0`. (`Release guard` checks that `dev` contains every commit on `main` and `package.json` has a higher stable version.)
3. **Merge with a merge commit** (the only merge method permitted on `main`).
4. **Publish:** In GitHub *Releases → Draft a new release*, create tag `v0.3.0` targeting `main`, click *Generate release notes*, and publish. Watch the **Publish to npm** workflow finish cleanly.
5. **Sync `main` back into `dev`:** Open a PR from `main` into `dev` titled `chore: sync main into dev` and merge it with a **merge commit** so `main` and `dev` keep sharing history.

---

## Prerelease

Bump `package.json` `version` on `dev` (for example `0.3.0-rc.1`) through a regular PR, then publish a GitHub Release with tag `v0.3.0-rc.1` targeting `dev` and tick *Set as a pre-release*. This publishes to the `next` npm dist-tag without affecting `latest`.

---

## Hotfix

1. Branch directly from `main`:
   ```sh
   git switch main && git pull && git switch -c hotfix/short-name
   ```
2. Apply the fix and bump the patch version (`0.3.0` → `0.3.1`) on the same branch.
3. Open a PR into `main` titled `fix(scope): ...` and merge with a **merge commit**.
4. Publish a GitHub Release `v0.3.1` on `main`.
5. Sync `main` back into `dev` with a **merge commit** (step 5 under [Stable release](#stable-release)) before the next release PR from `dev`.

---

## Credentials and emergency publish

> [!WARNING]
> Published npm versions are immutable. If a broken version goes live, ship a new patch version rather than trying to replace an existing tag.

- **Token:** CI publishes with the repository's `NPM_TOKEN` Actions secret. If it expires or is revoked, replace it with a token permitted to publish `ds-dot` without an interactive 2FA prompt. Never commit tokens to the repository.
- **Dry runs and reruns:** Trigger **Publish to npm** manually from *Actions* (`workflow_dispatch`) to verify tests and `npm pack` without publishing. Failed release runs can be rerun after fixing the underlying issue.
- **Emergency local publish:** Run the full gate and inspect the tarball contents first:
  ```sh
  pnpm typecheck && pnpm test && pnpm build
  npm pack --dry-run --ignore-scripts
  ```
  Then publish using an environment-backed npm config:
  ```ini
  //registry.npmjs.org/:_authToken=${NPM_TOKEN}
  registry=https://registry.npmjs.org/
  ```
  ```sh
  npm publish --access public --ignore-scripts
  ```

---

## Repository setup (one-time)

Configure once in GitHub repository settings:

- **Rulesets:** Under *Settings → Rules → Rulesets → New ruleset → Import a ruleset*, import [`.github/rulesets/main.json`](../.github/rulesets/main.json) and [`.github/rulesets/dev.json`](../.github/rulesets/dev.json).
- **Pull Requests:** Under *Settings → General → Pull Requests*, enable *Allow merge commits* (default title: *Pull request title*, default message: *Blank*), disable *Allow squash merging* and *Allow rebase merging*, and enable *Automatically delete head branches*.
- **Default branch:** Keep `main` as the default branch so the repository opens on the latest published release.
- **Actions permissions:** Under *Settings → Actions → General*, keep *Workflow permissions* set to *Read repository contents*.
- **GitHub Pages:** Under *Settings → Pages → Build and deployment*, set *Source* to **GitHub Actions** so [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) deploys `docs/` automatically whenever `main` updates.
