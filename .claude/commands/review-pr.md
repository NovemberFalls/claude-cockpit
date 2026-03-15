# Review PR

Thoroughly audit a pull request for security, quality, and compliance before merge. Takes a PR number as argument.

**Usage:** `/review-pr 42` or `/review-pr https://github.com/NovemberFalls/claude-cockpit/pull/42`

## Steps

1. **Fetch PR details**:
   ```
   gh pr view {number} --repo NovemberFalls/claude-cockpit --json title,body,author,files,additions,deletions,baseRefName,headRefName,labels,reviews,state
   ```

2. **Fetch the full diff**:
   ```
   gh pr diff {number} --repo NovemberFalls/claude-cockpit
   ```

3. **Security audit** — Check the diff for:
   - **Injection risks**: Any `eval()`, `exec()`, `subprocess.run(shell=True)`, `dangerouslySetInnerHTML`, `innerHTML`, or template string injection
   - **Credential exposure**: Hardcoded API keys, tokens, passwords, secrets, `.env` values
   - **Path traversal**: Unsanitized file paths, `../` in user inputs, arbitrary file read/write
   - **Dependency attacks**: New dependencies added to `package.json` or `requirements.txt` — verify they are legitimate packages (check for typosquatting, low download counts, suspicious names)
   - **PTY escape**: Changes to `pty_manager.py` or `conpty.py` that could allow command injection or terminal escape
   - **Auth bypass**: Changes to `auth.py` or session middleware that weaken authentication
   - **XSS vectors**: User-controlled content rendered without sanitization in React components
   - **CORS changes**: Any modifications to CORS configuration in `server.py`
   - **CSP changes**: Any modifications to Content Security Policy in `tauri.conf.json`
   - **WebSocket security**: Changes to WS bridge that could leak data or allow unauthorized access
   - **License compliance**: New dependencies must be compatible with AGPL-3.0

4. **Code quality audit** — Check the diff for:
   - **Convention violations**: `print()` instead of logger, JS mouse handlers instead of CSS hover classes, nested React components instead of module-scope
   - **Error handling**: Bare `except Exception: pass` without logging
   - **Test coverage**: Are new features covered by tests? Are existing tests modified or deleted?
   - **Breaking changes**: Does this change the session model, API endpoints, or WebSocket protocol?
   - **Performance**: Unnecessary re-renders, missing React.memo, expensive operations in render path
   - **Dead code**: Orphaned imports, unused variables, commented-out code blocks

5. **Compliance check**:
   - Changes don't introduce Windows-incompatible code without feature flags
   - Changes follow the existing architecture patterns (see CLAUDE.md)
   - Commit messages are descriptive
   - No binary files committed (images, executables)
   - No large files (>1MB) without justification

6. **Check PR CI status**:
   ```
   gh pr checks {number} --repo NovemberFalls/claude-cockpit
   ```

7. **Generate review report** with these sections:
   - **Summary**: What this PR does in 1-2 sentences
   - **Security**: PASS/WARN/FAIL with details
   - **Quality**: PASS/WARN/FAIL with details
   - **Tests**: Are they sufficient?
   - **CI**: Passing?
   - **Recommendation**: APPROVE / REQUEST CHANGES / NEEDS DISCUSSION
   - **Specific feedback**: Line-by-line comments on issues found

8. **If approved**, post the review:
   ```
   gh pr review {number} --repo NovemberFalls/claude-cockpit --approve --body "Review report here"
   ```
   **If changes requested**, post with request-changes:
   ```
   gh pr review {number} --repo NovemberFalls/claude-cockpit --request-changes --body "Review report here"
   ```

## Critical — Always Block PRs That:
- Add `eval()`, `exec()`, or `shell=True` without clear justification
- Modify auth.py to weaken authentication
- Add new npm/pip dependencies without clear need
- Remove or weaken test assertions
- Introduce hardcoded credentials or secrets
- Modify .gitignore to include previously-ignored sensitive files
- Change CORS to allow all origins
- Remove or weaken CSP headers
