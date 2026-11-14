# Publishing ds-dot

The current package version is `0.1.0`. The npm package includes the built host
entries and browser client; consumers do not need to build it.

## Release

1. Update `package.json` to the version being released and commit the changes.
2. Push the commit and create a GitHub Release with a matching tag, such as
   `v0.1.1` for package version `0.1.1`.
3. Publish the Release. The **Publish to npm** workflow checks the version,
   installs the locked dependencies, runs type checks and tests, builds the
   package, inspects its contents, and publishes it to npm.

Use a prerelease version such as `0.2.0-rc.1` with a GitHub prerelease. Prereleases
use the npm `next` tag; stable releases use `latest`.

The workflow reads the repository's `NPM_TOKEN` Actions secret. If the token
expires or is revoked, replace that secret with a token that can publish
`ds-dot` without an interactive two-factor prompt. Never commit the token.

You can run the workflow manually from GitHub Actions to check installation,
tests, building, and packing without publishing. Failed release runs can be
rerun from GitHub Actions after fixing their cause.

## Local publication

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

Each npm version can be published only once. The initial `0.1.0` is published
locally; the Release workflow handles subsequent versions.
