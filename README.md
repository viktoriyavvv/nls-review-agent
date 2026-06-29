# nls-review-agent

Local CLI to automate **frontend code review** in NLS.

You enter a Jira key (and optionally a repo), and the tool:

1. Resolves the target repo by Jira key or `--repo`.
2. Fetches the Jira issue via the API.
3. Finds the related Bitbucket PR in that repo.
4. Creates a dedicated **git worktree** for the change.
5. Collects git metadata + diff.
6. Builds a context file for Claude.
7. Runs the Claude CLI in non-interactive mode.
8. Saves the result to `outputs/<issueKey>/<repoId>/review.md` and `review.json`.

> **Read-only MVP.** It never comments, approves, requests changes, or merges on
> Jira/Bitbucket. Write actions exist only as future-facing interfaces
> (`BitbucketWriteClient`) and are not wired in.

---

## Requirements

- Node.js 20+
- git 2.x (with `git worktree`)
- Claude CLI on PATH (configurable via `CLAUDE_BIN`)
- Access to your Jira and Bitbucket Data Center / Server instances

## Install

```bash
npm install
npm run build
```

This compiles `src/` to `dist/`. The CLI entry point is `dist/cli.js`.

Run it one of these ways:

```bash
# directly
node dist/cli.js <command>

# via npm link (registers the `nls-review` command globally)
npm link
nls-review <command>

# or during development without building
npm run dev -- <command>
```

The examples below use `nls-review <command>`; substitute `node dist/cli.js <command>` if you did not `npm link`.

## Configure

### 1. Environment

Copy `.env.example` to `.env` and fill it:

```env
JIRA_BASE_URL=https://jira.your-company.kz
JIRA_EMAIL=you@company.kz          # Jira Cloud basic auth (email + token)
JIRA_API_TOKEN=...                 # for Jira DC PAT: leave email empty, set token

BITBUCKET_BASE_URL=https://bitbucket.your-company.kz
BITBUCKET_USERNAME=you             # DC basic auth (username + token/password)
BITBUCKET_TOKEN=...                # or a DC HTTP access token (used as Bearer if username empty)

CLAUDE_BIN=claude
CLAUDE_MODEL=opus
CLAUDE_EFFORT=max
CLAUDE_PERMISSION_MODE=dangerously-skip-permissions
CLAUDE_OUTPUT_FORMAT=json
```

### 2. Clone your repos

The tool does **not** clone for you. Clone each repo into `repos/` (matching the
`path` in `config/repos.yml`):

```bash
git clone <remote-url> repos/support-center-frontend
git clone <remote-url> repos/website-frontend
git clone <remote-url> repos/website-admin
```

### 3. Map repos in `config/repos.yml`

The top-level key under `repos:` is the **repo id**, not the Jira prefix. One Jira
prefix may map to several repos:

```yaml
repos:
  website-frontend:
    jiraPrefixes: ["WEBSITE"]
    path: "./repos/website-frontend"
    defaultBaseBranch: "origin/master"
    reviewProfile: "frontend-website"
    bitbucket: { projectKey: "WEB", repoSlug: "website-frontend" }

  website-admin:
    jiraPrefixes: ["WEBSITE"]
    path: "./repos/website-admin"
    defaultBaseBranch: "origin/master"
    reviewProfile: "frontend-website-admin"
    bitbucket: { projectKey: "WEB", repoSlug: "website-admin" }
```

Other config files:

- `config/review-profiles.yml` — maps a repo's `reviewProfile` to prompt files.
- `config/jira-fields.yml` — standard + custom Jira fields to request.
- `prompts/frontend-tl-review.md` — the review instructions.
- `prompts/output-format.md` — the required JSON output shape.

## Claude run mode

Claude запускается в том же режиме, который используется вручную для CR:

- model: `opus`
- effort: `max`
- permissions: `dangerously-skip-permissions`
- output-format: `json`

Эффективная команда (из cwd конкретного worktree, контекст подаётся через stdin):

```bash
claude -p "<context>" \
  --dangerously-skip-permissions \
  --effort max \
  --model opus \
  --output-format json
```

Настраивается через `.env` (`CLAUDE_MODEL`, `CLAUDE_EFFORT`,
`CLAUDE_PERMISSION_MODE`, `CLAUDE_OUTPUT_FORMAT`, `CLAUDE_BIN`) или блок `claude:`
в `config/repos.yml`. `--max-turns` по умолчанию не передаётся (опционально через
`CLAUDE_MAX_TURNS` или `claude.maxTurns`). `--max-budget-usd` больше не используется.

> Важно: MVP не выполняет write-действия в Jira/Bitbucket. Агент работает локально
> внутри изолированного git worktree.

## Commands

```bash
nls-review init                  # create folders + example config/env/prompts
nls-review repos                 # list configured repos
nls-review sync                  # git fetch --all --prune for every repo
nls-review sync --repo website-admin

nls-review run SC-3749                                  # prefix maps to one repo
nls-review run WEBSITE-123 --repo website-frontend     # prefix maps to many repos
nls-review run WEBSITE-123 --repo website-admin
nls-review run WEBSITE-123 --repo website-admin --allow-unmapped

nls-review clean SC-3749                  # remove that worktree (outputs kept)
nls-review clean WEBSITE-123 --repo website-admin
nls-review clean --older-than 14d         # remove stale worktrees (outputs kept)
```

### Repo resolution

- **No `--repo`:** the Jira prefix is matched against `jiraPrefixes`. Exactly one
  match runs automatically; several matches stop with a list asking for `--repo`;
  none stops with an error.
- **`--repo <id>`:** the repo must exist and the prefix must be in its
  `jiraPrefixes`, unless you pass `--allow-unmapped`.

The same Jira key can be reviewed in parallel across different repos — worktrees,
outputs, and locks are all keyed by `(issueKey, repoId)`.

## Output

Everything for one run lands in `outputs/<issueKey>/<repoId>/`:

| File | What |
|------|------|
| `jira.json` | raw issue + normalized fields + changelog |
| `pr.json` | chosen PR, candidates, details, comments, commits, diffstat |
| `git-meta.json` | HEAD, branch, base, changed files, diff stat |
| `changed-files.txt` | list of changed files |
| `diff.patch` | full diff vs base branch |
| `context.md` | the prompt sent to Claude |
| `review.raw.json` | raw Claude CLI output |
| `review.json` | normalized `ReviewResult` |
| `review.md` | human-readable review |
| `error.md` | present only on STOP / hard failures |

Worktrees live in `worktrees/<repoId>/<issueKey>`.

## Locking

- `locks/tasks/<issueKey>__<repoId>.lock` — one review per issue+repo at a time.
- `locks/repos/<repoId>.lock` — held during `git fetch` for a repo.
- Locks older than 2 hours are treated as stale and overwritten with a warning.

## Develop / test

```bash
npm run dev -- run SC-3749     # run from TS without building
npm test                       # unit tests (vitest)
npm run typecheck              # tsc --noEmit
```

## Bitbucket support

- **Data Center / Server:** implemented (`/rest/api/1.0/...`).
- **Cloud:** stub with the same interface (`BitbucketCloudClient`) — TODO.

## Roadmap / TODO

- Bitbucket Cloud client.
- Optional write-back (PR comment / status) behind an explicit flag — interfaces
  are defined in `bitbucket.types.ts` but not implemented.
- Inline-diff Bitbucket comments.
