#!/usr/bin/env bash
# Initialize git in this folder, create a GitHub repo via `gh`, push.
# Run ONCE. After that, use plain git (git add / commit / push).
#
# Override defaults with env vars:
#   REPO_NAME=my-name VISIBILITY=private bash scripts/init-github.sh

set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────
REPO_NAME="${REPO_NAME:-youtube-speed-reader}"
VISIBILITY="${VISIBILITY:-public}"        # public | private
DESCRIPTION="${DESCRIPTION:-Chrome extension that reads YouTube captions one word at a time, RSVP-style with ORP highlighting.}"
# ──────────────────────────────────────────────────────────────────────────

# cd to repo root regardless of where this was run from
cd "$(dirname "$0")/.."

step() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

# Sanity checks
if ! command -v gh >/dev/null 2>&1; then
    err "GitHub CLI not found. Install with: brew install gh"
    exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
    err "Not signed in to gh. Run: gh auth login"
    exit 1
fi
if ! command -v git >/dev/null 2>&1; then
    err "git not found."
    exit 1
fi

GITHUB_USER="$(gh api user -q .login)"
REMOTE_HTTPS="https://github.com/${GITHUB_USER}/${REPO_NAME}"

# Initialize repo if not already
if [ ! -d .git ]; then
    step "git init"
    git init -q
    git branch -M main
fi

# Set up .gitignore if somehow missing
if [ ! -f .gitignore ]; then
    cat > .gitignore <<'EOF'
dist/
__pycache__/
*.pyc
.DS_Store
EOF
    ok "wrote .gitignore"
fi

step "staging files"
git add -A

if git diff --cached --quiet; then
    ok "nothing new to commit"
else
    git commit -q -m "Initial commit: extension scaffolding + dev/prod build"
    ok "committed"
fi

# Create remote (or push to existing)
if gh repo view "${GITHUB_USER}/${REPO_NAME}" >/dev/null 2>&1; then
    step "remote already exists at ${REMOTE_HTTPS}"
    if ! git remote get-url origin >/dev/null 2>&1; then
        git remote add origin "${REMOTE_HTTPS}.git"
    fi
    git push -u origin main
else
    step "creating ${REMOTE_HTTPS} (${VISIBILITY})"
    gh repo create "${REPO_NAME}" \
        --"${VISIBILITY}" \
        --description "${DESCRIPTION}" \
        --source=. \
        --remote=origin \
        --push
fi

echo
ok "done — ${REMOTE_HTTPS}"
echo "  open in browser:  gh repo view -w"
