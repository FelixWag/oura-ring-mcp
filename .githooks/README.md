# Git hooks

`pre-commit` blocks personal data from reaching this public repository:
an Apple Developer Team ID (Xcode writes one into a project file as soon as
you pick a signing team), private tailnet addresses, anything shaped like a
token, email addresses, and any `chiron-wiki/` path.

Hooks are not shared by git, so enable them once per clone:

```bash
git config core.hooksPath .githooks
```

`git commit --no-verify` bypasses it when you are certain a match is a false
positive.

**The habit the hook cannot enforce:** stage explicit paths. `git add -A`
sweeps up whatever an IDE happened to write, which is exactly how a signing
identity reached this repo once already.
