## What and why

<!-- One or two sentences. The PR title becomes the merge commit subject, so
keep it in Conventional Commits form: feat(scope): summary -->

Closes #

## How it was checked

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Tried it in DeepSeek Harness (describe below, or explain why not needed)
- [ ] Updated Dorothy's blog (`docs/` via `.agents/skills/ds-dot-blog/`, merging overlapping posts or adding new ones with real PR dates & `RECORDINGS`) and READMEs/`docs/reference.md` for user-facing changes (or N/A)

## Frontend demo

<!-- See CONTRIBUTING.md, "Frontend changes".
Visible in normal use: delete the line below and embed a GIF recorded in
DeepSeek Harness from this pull request's code. It shows the changed
interaction and the on-screen result, including a fix, and names the commit
that was recorded. A still screenshot, a mockup, or a written claim does not
meet the rule. Keep keys, tokens, and personal data out of the recording. CI
does not check the GIF.
Visible only in a failure state (backend not loaded, version mismatch, host
error): replace the line below with the state and the tests that render it.
Nothing visible changes: leave the line below.
-->

No frontend changes.

## Notes for reviewers

<!-- Risky areas and follow-ups. Delete if empty. -->

<!--
Target branch:
  - normal work      -> dev   (merge commit)
  - release          -> main  from dev, title "release: vX.Y.Z" (merge commit)
  - hotfix           -> main  from hotfix/*, bump the patch version (merge commit)
  - sync after main  -> dev   from main, title "chore: sync main into dev" (merge commit)
-->
