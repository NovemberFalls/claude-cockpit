# Audit Repo

Comprehensive security and health audit of the Claude Cockpit repository. Run this periodically or before releases to ensure the project is in good shape.

## Steps

1. **Check for exposed secrets**:
   ```
   cd /c/Code/Personal/claude-cockpit
   git log --all --diff-filter=A -- "*.env" "*.pem" "*.key" "*credentials*" "*secret*" 2>/dev/null
   ```
   Also search tracked files for hardcoded secrets:
   - Search all `.py`, `.js`, `.jsx`, `.json`, `.toml` files for patterns: `password`, `secret`, `token`, `api_key`, `client_id`, `client_secret`, `private_key`, `bearer`, hardcoded URLs with credentials
   - Verify `.env` is in `.gitignore` and NOT tracked
   - Verify `.cockpit-relay.json` is NOT tracked
   - Verify `.claude/commands/deploy-cockpit.md` is NOT tracked (contains server infra details)

2. **Dependency vulnerability scan**:
   ```
   cd /c/Code/Personal/claude-cockpit/web/frontend && npm audit 2>&1
   ```
   ```
   cd /c/Code/Personal/claude-cockpit && pip audit 2>/dev/null || echo "pip-audit not installed — install via: pip install pip-audit"
   ```
   - Flag any high/critical vulnerabilities
   - Check for typosquatting: verify each dependency name is the official package

3. **License compliance**:
   - Verify all npm dependencies are AGPL-3.0 compatible (MIT, Apache-2.0, BSD, ISC are fine; GPL-2.0-only is NOT)
   ```
   cd /c/Code/Personal/claude-cockpit/web/frontend && npx license-checker --summary 2>/dev/null || echo "Run: npx license-checker --summary"
   ```
   - Check for copyleft license conflicts

4. **Check for forks and external activity**:
   ```
   gh api repos/NovemberFalls/claude-cockpit --jq '{forks: .forks_count, stars: .stargazers_count, watchers: .watchers_count, open_issues: .open_issues_count}'
   gh api repos/NovemberFalls/claude-cockpit/forks --jq '.[].full_name'
   ```

5. **Review open PRs and issues**:
   ```
   gh pr list --repo NovemberFalls/claude-cockpit --state open
   gh issue list --repo NovemberFalls/claude-cockpit --state open
   ```

6. **Test suite health**:
   ```
   cd /c/Code/Personal/claude-cockpit && python -m pytest web/tests/ -v
   cd /c/Code/Personal/claude-cockpit/web/frontend && npm test
   cd /c/Code/Personal/claude-cockpit/web/frontend && npm run lint
   ```
   - All tests must pass
   - No lint errors

7. **Build verification**:
   ```
   cd /c/Code/Personal/claude-cockpit/web/frontend && npm run build
   ```
   - Build must complete with zero errors

8. **Git health**:
   ```
   git log --oneline -20
   git count-objects -vH
   gh api repos/NovemberFalls/claude-cockpit --jq '.size'
   ```
   - Verify no large binary files crept back in
   - Check repo size is reasonable (<5MB source)

9. **CI/CD status**:
   ```
   gh run list --repo NovemberFalls/claude-cockpit --limit 5
   ```
   - Verify recent runs are passing

10. **Generate audit report** with sections:
    - **Secrets**: PASS/FAIL — any exposed credentials?
    - **Dependencies**: PASS/WARN/FAIL — vulnerabilities found?
    - **License**: PASS/FAIL — all deps AGPL-3.0 compatible?
    - **Community**: Stats (forks, stars, open issues/PRs)
    - **Tests**: PASS/FAIL — all passing?
    - **Build**: PASS/FAIL — clean build?
    - **Repo Health**: Size, recent commits, CI status
    - **Recommendations**: Action items if any issues found
