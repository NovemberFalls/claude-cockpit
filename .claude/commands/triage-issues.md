# Triage Issues

Review and triage all open GitHub issues and PRs. Label, prioritize, and respond to community contributions.

## Steps

1. **Fetch all open issues**:
   ```
   gh issue list --repo NovemberFalls/claude-cockpit --state open --json number,title,author,labels,createdAt,comments --limit 50
   ```

2. **Fetch all open PRs**:
   ```
   gh pr list --repo NovemberFalls/claude-cockpit --state open --json number,title,author,labels,createdAt,reviewDecision,files,additions,deletions --limit 50
   ```

3. **For each issue**, classify as:
   - **Bug**: Reproducible defect → label `bug`, assess severity (critical/high/medium/low)
   - **Feature**: New functionality request → label `enhancement`, assess feasibility
   - **Question**: Usage help → label `question`, draft a helpful response
   - **Duplicate**: Already reported → label `duplicate`, link to original, close
   - **Invalid**: Not a real issue → label `invalid`, explain why, close
   - **Won't Fix**: Valid but out of scope → label `wontfix`, explain reasoning

4. **For each PR**, assess:
   - Does it follow CONTRIBUTING.md guidelines?
   - Is CI passing?
   - Does it need a `/review-pr` security audit? (Always yes for code changes)
   - Is the scope reasonable? (Not too large, focused on one thing)
   - Draft a response: thank the contributor, request changes if needed, or approve

5. **Priority labels**:
   - `priority: critical` — Security vulnerability, data loss, crash on startup
   - `priority: high` — Major feature broken, significant UX regression
   - `priority: medium` — Minor bug, nice-to-have improvement
   - `priority: low` — Cosmetic, documentation, edge case

6. **Area labels**:
   - `area: backend` — server.py, pty_manager.py, auth.py, tunnel.py
   - `area: frontend` — React components, themes, CSS
   - `area: desktop` — Tauri, installer, sidecar
   - `area: docs` — README, CONTRIBUTING, CLAUDE.md
   - `area: ci` — GitHub Actions, testing

7. **Apply labels**:
   ```
   gh issue edit {number} --repo NovemberFalls/claude-cockpit --add-label "bug,priority: high,area: backend"
   ```

8. **Post responses** to issues/PRs that need attention:
   ```
   gh issue comment {number} --repo NovemberFalls/claude-cockpit --body "Response here"
   ```

9. **Generate triage summary**:
   - Total open issues / PRs
   - Breakdown by priority and area
   - Action items: what needs immediate attention
   - Stale items: issues/PRs with no activity in 30+ days

## Response Templates

**Bug acknowledged:**
> Thanks for reporting this! I can reproduce the issue. I'll look into a fix for the next release.

**Feature request acknowledged:**
> Thanks for the suggestion! This is an interesting idea. I'll evaluate feasibility and add it to the roadmap if it fits.

**PR feedback:**
> Thanks for contributing! I've reviewed the changes and have some feedback below. Please address these items and I'll take another look.

**Closing as duplicate:**
> This is a duplicate of #{original}. Closing in favor of the existing issue. Feel free to add additional context there!
