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

nls-review clone support-center-frontend # git clone into ./repos/<id> (no token in URL)

nls-review run SC-3749                                  # prefix maps to one repo
nls-review run WEBSITE-123 --repo website-frontend     # prefix maps to many repos
nls-review run WEBSITE-123 --repo website-admin
nls-review run WEBSITE-123 --repo website-admin --allow-unmapped
nls-review run SC-3749 --no-sync                        # skip the automatic git fetch

nls-review followup SC-3563                             # resumes the initial Claude session + /compact
nls-review followup SC-3563 --no-resume                 # stateless follow-up (old behaviour)
nls-review followup SC-3563 --resume-session <id>       # resume a specific Claude session id
nls-review followup SC-3563 --no-sync                   # skip the automatic git fetch

nls-review clean SC-3749                  # remove that worktree (outputs kept)
nls-review clean WEBSITE-123 --repo website-admin
nls-review clean --older-than 14d         # remove stale worktrees (outputs kept)

# Review Memory Engine (local, human-approved)
nls-review memory init                    # create memory/ structure + seed principles + index
nls-review memory list [--project SC] [--repo <id>] [--type lesson] [--status approved]
nls-review memory show <id>
nls-review memory search <query>
nls-review memory reindex                 # rebuild memory/index.json

nls-review memory propose SC-3563 --repo <repoId>   # Claude drafts PENDING proposals from outputs
nls-review memory approve <proposalId>              # human approval -> used in future reviews
nls-review memory reject <proposalId>

nls-review learn bugfix SC-3706 --repo <repoId>     # analyze a post-review bugfix -> PENDING lesson
```

### Auto-sync, and Claude session continuity

- **Every `run` and `followup` first does `git fetch --all --prune`** for the target
  repo, so the change is always checked against fresh remote state. Pass
  `--no-sync` to skip it.
- The initial `run` **saves the Claude session id** to
  `outputs/<issue>/<repo>/claude-session.json`. A later `followup` **resumes that
  session** (`claude --resume <id>`) and issues `/compact` before the follow-up
  prompt, so the model keeps the original discussion's context. Use `--no-resume`
  for the old stateless behaviour, or `--resume-session <id>` to force a specific
  session. If resume fails, the follow-up automatically falls back to stateless
  (recorded in the follow-up's `claudeSession` metadata) — it never hard-fails.
- Set `CLAUDE_OUTPUT_FORMAT=stream-json` for reliable session ids **and** live,
  event-by-event Claude output in the GUI (falls back cleanly to `json`).

### Review Memory Engine

The agent **learns from past reviews without fine-tuning**: memory lives in
local markdown files under `memory/` (global rules, project/repo rules,
decisions, lessons, accepted exceptions, false positives), each with YAML
frontmatter (`id`, `type`, `status`, `confidence`, `appliesTo`). An index is
generated at `memory/index.json` (`memory reindex`).

- **Retrieval before every `run`/`followup`**: approved items matching the repo,
  project prefix, issue key or diff keywords (tags found in the diff/changed
  files) are ranked (repo > project > tags > confidence > recency), capped
  (20 items / 12 000 chars) and injected into `context.md` /
  `followup-context.md` as a `## Memory Context` block. What was used is
  recorded next to the outputs in `memory-context.md` + `memory-used.json`.
- **Human-in-the-loop learning**: `memory propose` / `learn bugfix` ask Claude
  to draft memory items, which land in `memory/proposals/pending/` as
  `status: proposed`. **Nothing becomes approved automatically** — you approve
  (moves lessons into `memory/lessons/`) or reject from the GUI `/memory` page
  or the CLI. Only `approved` items ever reach a review prompt; rejected /
  deprecated / pending items never do.
- The review prompts instruct the model to treat memory as context, not truth:
  findings still require evidence from the current code/diff/Jira.

### Repo resolution

- **No `--repo`:** the Jira prefix is matched against `jiraPrefixes`. Exactly one
  match runs automatically; several matches stop with a list asking for `--repo`;
  none stops with an error.
- **`--repo <id>`:** the repo must exist and the prefix must be in its
  `jiraPrefixes`, unless you pass `--allow-unmapped`.

The same Jira key can be reviewed in parallel across different repos — worktrees,
outputs, and locks are all keyed by `(issueKey, repoId)`.

## GUI

A local web GUI wraps the same CLI (it shells out to `node dist/cli.js …` and
reads `outputs/`). It is **read-only towards Jira/Bitbucket** — exactly like the
CLI — and is meant for a single local user; there is no auth, database, or deploy.

```bash
# one-time: install backend + frontend deps
npm install
npm install --prefix web      # or: npm run gui:install

# build everything and start the GUI on one port
npm run gui
```

Then open:

```text
http://localhost:5174
```

(Override the port with `GUI_PORT`.)

Navigation: **Dashboard · JQL Queue · History · Memory · Repos · Jobs · Settings**.

What you can do:

- work a **Jira JQL Queue** (`/jql`): paste a JQL, **save/name** it (persisted to
  `config/jql-queries.json`), run it read-only against Jira, and get a Jira-like
  table of issues — with per-issue **repo resolution** (single / choose-one /
  none), existing **review + follow-up verdicts** from `outputs/`, and one-click
  **Open Jira / Open Result / Run Review / Run Follow-up / Sync / Copy key**;
- manage **review memory** on `/memory`: tabs for Approved / Pending proposals /
  Rejected / Global / Projects / Repos / Lessons, search + filters, a read-only
  markdown viewer, and one-click **Approve / Reject / Deprecate**; a Results page
  **Memory block** shows what memory the last run used and can **Generate memory
  proposal** or **Analyze as bugfix** (both run as jobs with live logs);
- run an **initial review** or **follow-up** (auto-syncs the repo first; a toggle
  can turn that off, and a checkbox controls Claude-session resume for follow-ups);
- see the saved **Claude session** for the issue and whether the follow-up will
  resume it;
- browse **History** (`/history`) — every issue+repo found in `outputs/`, with
  latest review/follow-up verdicts, PR, last-run time, and one-click
  Open / Review / Follow-up / Clean;
- watch **live logs / progress** with a **current-stage banner** and, in
  `stream-json` mode, **live Claude output**; a **Jobs** page (`/jobs`) lists all
  jobs with status, stage, duration and logs;
- manage repos on **Repos** (`/repos`): **Clone** a missing repo, **Re-clone**,
  **Remove local** (with safety confirmation), **Sync**, and **Copy clone command**
  — clone URLs contain **no token** (username only; Git Credential Manager supplies
  the password);
- browse a run's **review.md**, **follow-ups**, **Jira**, **PR**, **Git**, and raw
  output **Files** (read-only), and **copy the Bitbucket comment**;
- check **config/env status** on the Settings page (tokens are never shown — only
  whether each credential is present).

Multi-repo issues (e.g. `WEBSITE-…`) require choosing a repo before running; the
dashboard auto-detects the repo when a prefix maps to exactly one.

> **Read-only & secret-safe.** The GUI never writes to Jira or Bitbucket. Every
> job log line is passed through a **sanitizer** that redacts token values and
> `Authorization`/`Bearer`/`Basic`/URL-embedded credentials before it reaches the
> browser. Local writes (clone/remove under `./repos`, worktrees, outputs) are
> allowed; deletes are constrained to inside the configured `reposDir`.

### Jira JQL Queue

The **JQL Queue** page (`/jql`) turns a JQL query into an actionable table:

- **Saved queries** live in `config/jql-queries.json` (no database; the file is
  created empty on first use and is git-ignored as personal data). Save / rename /
  delete them from the top of the page; they survive restarts.
- **Run JQL** calls Jira **read-only** (`POST /api/jql/search`). On Jira Cloud it
  uses the current `/rest/api/3/search/jql` endpoint (the classic `/search` was
  retired by Atlassian) with a best-effort approximate count; Server/Data Center
  keeps the classic `/search`. The page size defaults to 100 (max 200) and warns
  when the result set is truncated.
- Each row shows the issue fields (key, summary, status, assignee, updated,
  created…), the **resolved repo** (auto for a single-prefix match, a dropdown for
  a multi-repo prefix, or "no repo"), and any existing **review / follow-up**
  verdict read from `outputs/`. Row actions: **Open Jira**, **Open Result**,
  **Run Review**, **Run Follow-up**, **Sync**, **Copy key**. Multi-repo issues
  require picking a repo before a review/follow-up can start.

JQL errors (bad query, missing token) are surfaced as a clear message — the
server never crashes and never echoes the token.

### GUI architecture

- `src/server/` — an Express + SSE backend. It imports the existing read-only
  modules (`loadConfig`, repo resolution, path helpers) for listings, and runs
  `sync`/`run`/`followup`/`clean` as **child processes** of the CLI (argv array,
  no shell), streaming the CLI's log lines. Core logic and the CLI are unchanged.
- `web/` — a React + Vite + TypeScript SPA (dark theme).

### GUI scripts

```bash
npm run gui            # build CLI + web, then serve both on GUI_PORT (default 5174)
npm run gui:serve      # serve a pre-built GUI (skip the build)
npm run build:gui      # build CLI + web only
npm run dev:gui        # dev mode: Express (tsx watch) + Vite dev server (HMR) — open :5173
npm run gui:install    # install root + web/ dependencies
```

> Dev-tooling note: `npm audit` flags advisories in the Vite/Vitest/esbuild
> **dev** chain. They only apply to the Vite dev server (`dev:gui`) and the
> Vitest UI, not to the production GUI (`npm run gui` serves pre-built static
> assets via Express). They are not in the runtime path.

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
