## What and why

<!-- One or two sentences. The PR title becomes the squash commit, so keep it in
Conventional Commits form: feat(scope): summary -->

Closes #

## How it was checked

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Tried it in DeepSeek Harness (describe below, or explain why not needed)

## Notes for reviewers

<!-- Risky areas, follow-ups, screenshots for UI changes. Delete if empty. -->

<!--
Target branch:
  - normal work      -> dev   (squash merge)
  - release          -> main  from dev, title "release: vX.Y.Z" (merge commit)
  - hotfix           -> main  from hotfix/*, bump the patch version (merge commit)
  - sync after main  -> dev   from main, title "chore: sync main into dev" (merge commit)
-->
