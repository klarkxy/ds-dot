# Publishing ds-dot

The npm package includes the built host entries and browser client; consumers
do not need to build it. Publishing a GitHub Release is the single action that
both records the tag and starts npm publish (`.github/workflows/publish.yml`).

| Release kind | Version example | Tagged on | GitHub Release | npm dist-tag |
|---|---|---|---|---|
| Stable | `0.3.0` | `main` | normal | `latest` |
| Prerelease | `0.3.0-rc.1` | `dev` (or `main`) | marked *pre-release* | `next` |

The publish workflow refuses a release whose tag does not match
`package.json`, whose prerelease flag does not match the version, or whose
commit is not on the allowed branch.

## Stable release

1. **Prepare on `dev`.** Open a PR into `dev` titled `release: prepare v0.3.0`
   that sets `package.json` `version` to `0.3.0` (and updates the version shown
   in this file if needed). Squash-merge it.
2. **Open the release PR** from `dev` into `main`, titled `release: v0.3.0`.
   The `Release guard` check verifies that:
   - the source branch is `dev` (or `hotfix/*`),
   - `dev` already contains every change on `main` (see *Sync* below),
   - the version is stable and greater than the one on `main`.
3. **Merge with a merge commit** (the only method allowed on `main`).
4. **Publish.** On GitHub, *Releases → Draft a new release*, create tag
   `v0.3.0` on `main`, click *Generate release notes* (they list the squashed
   PR titles from `dev`), and publish. Watch the **Publish to npm** run.
5. **Sync `main` back into `dev`.** Open a PR from `main` into `dev` titled
   `chore: sync main into dev` and merge it with a **merge commit**. It
   carries no code changes after a normal release, but keeps the branches
   sharing history.

## Prerelease

Bump `package.json` on `dev` to e.g. `0.3.0-rc.1` through a normal PR, then
create a GitHub Release with tag `v0.3.0-rc.1` targeting `dev` and tick
*Set as a pre-release*. It publishes under npm `next`; `latest` is untouched.

## Hotfix

1. Branch from `main`: `git switch main && git pull && git switch -c hotfix/short-name`.
2. Fix, and bump the patch version (`0.3.0` → `0.3.1`) in the same branch.
3. Open a PR into `main` titled `fix(scope): ...`; merge with a merge commit.
4. Publish a GitHub Release `v0.3.1` on `main`.
5. Sync `main` back into `dev` (step 5 above). Until this is done, the next
   release PR from `dev` fails `Release guard` on purpose.

## Secrets

The workflow reads the repository's `NPM_TOKEN` Actions secret. If the token
expires or is revoked, replace that secret with a token that can publish
`ds-dot` without an interactive two-factor prompt. Never commit the token.

You can run the workflow manually from GitHub Actions to check installation,
tests, building, and packing without publishing. Failed release runs can be
rerun from GitHub Actions after fixing their cause. Each npm version can be
published only once; if a published version is broken, release a new patch.

## Local publication (emergency only)

Run `pnpm typecheck`, `pnpm test`, and `pnpm build`, then inspect the package with
`npm pack --dry-run --ignore-scripts`. Publish the checked build using an npm
configuration that reads your token from the environment:

```ini
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
registry=https://registry.npmjs.org/
```

```sh
npm publish --access public --ignore-scripts
```

The initial `0.1.0` was published locally. GitHub Release `v0.2.0` reached
GitHub only because its Linux tests failed before the npm publish step.

## Repository settings

These live in GitHub, not in the code. Configure them once:

1. **Rulesets** — *Settings → Rules → Rulesets → New ruleset → Import a
   ruleset*, and import [`.github/rulesets/main.json`](../.github/rulesets/main.json)
   and [`.github/rulesets/dev.json`](../.github/rulesets/dev.json). They block
   direct pushes, force pushes and deletion, require one approval, require the
   checks `CI result` and `PR title` (plus `Release guard` on `main`), and allow
   only merge commits on `main` and squash or merge on `dev`. Repository admins
   may bypass them through a pull request, which lets a solo maintainer merge
   their own PRs; remove that bypass once there are regular reviewers.
2. **General → Pull Requests** — enable *Allow squash merging* with default
   message *Pull request title*, enable *Allow merge commits*, disable *Allow
   rebase merging*, and enable *Automatically delete head branches*.
3. **Default branch** — set to `dev`, so new PRs and clones target it by
   default. README links still work, and npm users never see `dev`.
4. **Actions → General** — keep *Workflow permissions* at *Read repository
   contents*.
