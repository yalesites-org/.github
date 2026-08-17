/**
 * Pure decision rules for the project status sync workflow.
 *
 * Everything in here is side-effect free so it can be unit tested with
 * `node --test`; all GitHub API work lives in sync.js.
 */

const STATUS_IN_REVIEW = 'In review';
const STATUS_READY_FOR_RELEASE = 'Ready for Release (in dev)';
const STATUS_DONE = 'Done';

/** The label on a pull request that means "this is ready to be reviewed". */
const NEEDS_REVIEW_LABEL = 'needs review';

/**
 * Board columns in workflow order, used to refuse backwards moves.
 *
 * "Blocked" sits before "In progress" deliberately: a pull request going up for
 * review means the work is no longer blocked, so In review may override it.
 */
const STATUS_ORDER = [
  'Backlog',
  'Ready For Work',
  'To Do',
  'Blocked',
  'In progress',
  STATUS_IN_REVIEW,
  STATUS_READY_FOR_RELEASE,
  STATUS_DONE,
];

/**
 * Ways a pull request can name its YaleSites-Internal ticket, most reliable
 * first. The branch name wins because `{issue-number}-{description}` is the
 * convention every YaleSites branch follows; the `References ...` body line is
 * deliberately not a closing keyword, so GitHub's own linking never sees it.
 */
const TICKET_PATTERNS = [
  { field: 'headRef', pattern: /^(\d+)-/ },
  // `hotfix/1394-campus-groups-sync-fix` carries a ticket, but the release
  // hotfix branches are named `hotfix/2230-hotfix-1`, where 2230 is version
  // 2.23.0 rather than a ticket. Exclude that suffix.
  { field: 'headRef', pattern: /^hotfix\/(\d+)-(?!hotfix-\d+$)/i },
  { field: 'title', pattern: /^\s*(\d+)\s*:/ },
  // Matches both the qualified `yalesites-org/YaleSites-Internal#1234` our PR
  // bodies use and a bare `YaleSites-Internal#1234`.
  //
  // A bare `Fixes #1234` is deliberately NOT matched: in a pull request that
  // number means an issue in that pull request's own repo, and those numbers
  // overlap YaleSites-Internal's almost exactly, so it would confidently move a
  // completely unrelated ticket. No YaleSites pull request uses that form.
  { field: 'body', pattern: /YaleSites-Internal#(\d+)/i },
];

/**
 * Finds the YaleSites-Internal ticket a pull request belongs to.
 *
 * @param {{headRef?: string, title?: string, body?: string}} pullRequest
 * @returns {number|null} The ticket number, or null when none can be found.
 */
function resolveTicketNumber({ headRef, title, body } = {}) {
  const fields = { headRef, title, body };

  for (const { field, pattern } of TICKET_PATTERNS) {
    const match = (fields[field] || '').match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

/**
 * Maps a pull_request event to the board status it should produce.
 *
 * Only the repo that cuts the platform release can mark a ticket Done. In
 * atomic and component-library-twig, a merge to `main` is an RC promotion — an
 * intermediate release-engineering step, not "shipped" — and the board already
 * reflects that: every ticket carried by the 2026-08-14 component-library-twig
 * RC (1529, 1532, 1536, 1537) still sits at "Ready for Release (in dev)".
 * Treating those merges as Done would mark tickets shipped a week or more early.
 *
 * @param {{action?: string, labelName?: string, merged?: boolean, baseRef?: string,
 *          repo?: string, productionRepo?: string}} event
 * @returns {string|null} The target status, or null when the event is not one we act on.
 */
function resolveTargetStatus({ action, labelName, merged, baseRef, repo, productionRepo } = {}) {
  if (action === 'labeled') {
    return (labelName || '').toLowerCase() === NEEDS_REVIEW_LABEL ? STATUS_IN_REVIEW : null;
  }

  if (action === 'closed' && merged) {
    if (baseRef === 'develop') {
      return STATUS_READY_FOR_RELEASE;
    }
    if ((baseRef === 'main' || baseRef === 'master') && repo === productionRepo) {
      return STATUS_DONE;
    }
  }

  return null;
}

/**
 * Whether a repository is allowed to drive the YaleSites Board.
 *
 * This workflow lives in a public repository, so GitHub will happily let *any*
 * repository call it. The token is the real access control — a caller without
 * `PROJECT_TOKEN` can do nothing — but that relies on the org secret's
 * visibility being set correctly and staying that way. This is the second lock:
 * an explicit list of the repos whose pull requests are allowed to move tickets.
 *
 * @param {string} repository The caller's full `owner/repo`.
 * @param {string} allowed Newline- or comma-separated list of allowed `owner/repo`.
 * @returns {boolean}
 */
function isAllowedCaller(repository, allowed) {
  const entries = String(allowed || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return entries.includes(String(repository || '').trim().toLowerCase());
}

/**
 * Reads the `owner/repo=branch` map naming each repo's production branch.
 *
 * Doubles as the list of repos the release sweep pays attention to. A ticket's
 * cross-references can reach repos with no release process at all — ticket 1349
 * is referenced from `yalesites-org/yalesites-claude-plugins` — and those must
 * not gate whether a ticket has shipped.
 *
 * @param {string} text One `owner/repo=branch` per line (or comma separated).
 * @returns {Map<string, string>} Lower-cased `owner/repo` to branch name.
 */
function parseReleaseBranches(text) {
  const branches = new Map();

  for (const entry of String(text || '').split(/[\n,]/)) {
    const [repository, branch] = entry.split('=');
    if (repository && branch && repository.trim() && branch.trim()) {
      branches.set(repository.trim().toLowerCase(), branch.trim());
    }
  }

  return branches;
}

/**
 * Whether a commit has reached a repo's production branch.
 *
 * Reads the result of comparing `productionBranch...mergeCommit`. GitHub reports
 * four statuses, and `ahead_by` collapses them into the only question that
 * matters — are there commits in the merge commit that production does not have?
 *
 *   identical -> ahead_by 0, contained (production is exactly this commit)
 *   behind    -> ahead_by 0, contained (production has moved on since)
 *   ahead     -> ahead_by > 0, NOT contained
 *   diverged  -> ahead_by > 0, NOT contained (merged to develop after the RC cut)
 *
 * @param {{aheadBy?: number}} comparison
 * @returns {boolean}
 */
function isContainedInProduction({ aheadBy } = {}) {
  return aheadBy === 0;
}

/**
 * Whether a GraphQL failure just means the ticket number does not exist.
 *
 * Octokit throws when a response carries an `errors` array, even alongside
 * partial data, so a number parsed out of a branch that was never a ticket
 * (`hotfix/2230-hotfix-1`) arrives here as an exception rather than a null.
 *
 * @param {Error & {errors?: Array<{type?: string}>}} error
 * @returns {boolean}
 */
function isMissingRecordError(error) {
  return Boolean(error && error.errors && error.errors.some((entry) => entry.type === 'NOT_FOUND'));
}

/**
 * Whether setting `targetStatus` would move the ticket forward on the board.
 *
 * Guards against an automation fighting the team: a ticket that has already
 * passed review and shipped must not be dragged back to "In review" by a late
 * label event, and re-applying the status a ticket already has is a no-op.
 *
 * @param {string|null} currentStatus
 * @param {string} targetStatus
 * @returns {boolean}
 */
function shouldApplyStatus(currentStatus, targetStatus) {
  const rank = (status) =>
    STATUS_ORDER.findIndex((known) => known.toLowerCase() === String(status).toLowerCase());

  const currentRank = currentStatus ? rank(currentStatus) : -1;
  if (currentRank === -1) {
    return true;
  }

  return rank(targetStatus) > currentRank;
}

module.exports = {
  STATUS_DONE,
  STATUS_IN_REVIEW,
  STATUS_READY_FOR_RELEASE,
  isAllowedCaller,
  isContainedInProduction,
  isMissingRecordError,
  parseReleaseBranches,
  resolveTargetStatus,
  resolveTicketNumber,
  shouldApplyStatus,
};
