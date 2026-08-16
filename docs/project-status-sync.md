# Project status sync

Keeps a ticket's **Status** on the [YaleSites Board](https://github.com/orgs/yalesites-org/projects/6)
in step with its pull request, so nobody has to move cards by hand.

The logic lives once, in this repository, and is called as a reusable workflow by
each code repo. That way there is a single place to change it.

- Reusable workflow: [`.github/workflows/project-status-sync.yml`](../.github/workflows/project-status-sync.yml)
- Logic and its unit tests: [`scripts/project-status-sync/`](../scripts/project-status-sync/)
- Caller workflow in each code repo: `.github/workflows/project_status_sync.yml`

## What triggers it, and what it sets

| Event on a pull request | Status it sets |
| --- | --- |
| The **`needs review`** label is added | **In review** |
| Merged into `develop` | **Ready for Release (in dev)** |
| Merged into `main` or `master` | **Done** |

Nothing else moves a ticket. A pull request that is closed without merging, or
merged into another feature branch (a stacked PR), is ignored.

### It never moves a ticket backwards

Status changes only ever move a ticket **forward** through
`Backlog → Ready For Work → To Do → Blocked → In progress → In review → Ready for Release (in dev) → Done`.

So a `needs review` label added to a follow-up PR cannot drag a ticket that has
already shipped back to *In review*, and re-applying a status a ticket already
has is skipped. `Blocked` sits before `In progress` on purpose: a pull request
going up for review means the work is no longer blocked, so *In review* is
allowed to override it.

This is also why the automation does not fight the manual review labels
(`pass code review`, `pass functional review`, `needs work`). Those are not
triggers — only `needs review` is — and even if one were re-added late, the
forward-only rule stops the ticket from regressing.

### Release promotions fan out

A merge into `main`/`master` from `develop`, `v2115`, or `release/*` is a release
promotion carrying many tickets rather than one. For those the workflow walks the
pull requests in the merge range and marks **every** linked ticket **Done**.
A hotfix branched straight to `master` is not a promotion and is treated as a
single ticket.

## How a pull request is matched to a ticket

Checked in this order, first match wins:

1. Branch name — `1234-description` or `hotfix/1234-description`
2. Pull request title — `1234: Some title`
3. Body — `yalesites-org/YaleSites-Internal#1234`, or a bare `YaleSites-Internal#1234`

GitHub's own `closingIssuesReferences` is deliberately **not** used: our PR bodies
say `References yalesites-org/YaleSites-Internal#1234`, which is not a closing
keyword, so GitHub never records the link. The branch name is the most reliable
signal because every YaleSites branch follows `{issue-number}-{description}`.

Two things are deliberately **not** matched, because both would confidently move
the wrong card:

- **A bare `Fixes #1234`.** In a pull request that number means an issue in that
  pull request's *own* repo, and those numbers overlap YaleSites-Internal's almost
  exactly (yalesites-project is around #1475, YaleSites-Internal around #1555), so
  it would resolve to a real but unrelated ticket. No YaleSites pull request uses
  that form. A qualified `YaleSites-Internal#1234` is unambiguous and is matched.
- **`hotfix/2230-hotfix-1`.** That 2230 is version 2.23.0, not a ticket. Release
  hotfix branches are excluded by their `-hotfix-N` suffix, while a genuine
  `hotfix/1394-campus-groups-sync-fix` still matches.

If no ticket can be found — a dependency bump, an `RC Update`, a number that
turns out not to be a real ticket — the workflow logs a warning and **exits
successfully**. It never fails a run or blocks a merge.

The same holds for API failures. Board bookkeeping is never worth a red X on a
merge, so any unexpected error is caught and logged as a warning. This matters
most on a release promotion, which walks hundreds of commits and pull requests: a
single transient 502 or rate limit would otherwise redden the release PR.

## Setup

### The token

Project v2 fields cannot be written with the default `GITHUB_TOKEN`. The workflow
needs **`PROJECT_TOKEN`**, the same secret name `YaleSites-Internal`'s
`07-label-to-project-fields.yml` already uses.

It must be an **organization**-level secret, shared with `yalesites-project`,
`atomic`, and `component-library-twig`. Secrets are not inherited from this
repository — each caller passes its own.

**Scope it as narrowly as it will go.** These three repos are public, and anyone
with write access to a public repo can run a workflow that reads a secret
available to it. A classic PAT with `repo` scope grants read *and write* on every
private repository its owner can reach, which is far more than this needs. Prefer,
in order:

1. A **GitHub App installation token**, or
2. A **fine-grained PAT** owned by a machine account, granting only
   organization **Projects: write** and **Issues: read** on `YaleSites-Internal`.

The workflow only ever reads an issue's project items and writes one Status field.

**Without the secret the workflow is dormant, not broken:** it logs a warning and
exits 0, so merges are never blocked by a red check.

### Protect this repository's default branch

The three code repos call this workflow at `@main`, and it runs `sync.js` from
`main` with `PROJECT_TOKEN` in scope. Anyone who can push directly to `main` here
can therefore run code against that token in three repos. `main` should require a
reviewed pull request and disallow force-pushes.

### Adding it to a new repo

Create `.github/workflows/project_status_sync.yml`:

```yaml
name: Project status sync

on:
  pull_request:
    types: [labeled, closed]

jobs:
  sync-status:
    name: Sync ticket status
    if: github.event.pull_request.head.repo.full_name == github.repository
    uses: yalesites-org/.github/.github/workflows/project-status-sync.yml@main
    secrets:
      PROJECT_TOKEN: ${{ secrets.PROJECT_TOKEN }}
```

Then make sure the org secret `PROJECT_TOKEN` is shared with that repository.

The `if:` skips pull requests from forks, where secrets are unavailable.

### Inputs

All optional; the defaults are what YaleSites uses.

| Input | Default | Purpose |
| --- | --- | --- |
| `project_number` | `6` | The YaleSites Board's Projects v2 number |
| `internal_owner` | `yalesites-org` | Owner of the repo holding the tickets |
| `internal_repo` | `YaleSites-Internal` | Repo holding the tickets |
| `dry_run` | `false` | Log what would change without writing to the board |

## Working on it

The decision rules are pure functions in
`scripts/project-status-sync/status-rules.js`, unit tested against real merged
pull requests from all three repos. `scripts/project-status-sync/sync.js` holds
the GitHub API calls.

```sh
node --test
```

CI runs the same command (`.github/workflows/test-scripts.yml`).

To try a change safely, set `dry_run: true` in a caller workflow: the run reports
every status it would set and writes nothing.

## Related automation

`YaleSites-Internal/.github/workflows/02-pr-status-monitor.yml` was an earlier
attempt at this. It has never affected real work — it listens for `pull_request`
events in `YaleSites-Internal`, where the pull requests it watches do not live,
and its dry-run flag evaluates to `true` on every non-manual run. It is inert
rather than conflicting, and retiring it is worth a follow-up ticket.
