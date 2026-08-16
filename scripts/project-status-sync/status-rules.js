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
 * Head branch names that promote a batch of already-merged work to production
 * rather than carrying a single ticket: `develop` (atomic and
 * component-library-twig RC updates), `v2115` and `release/2.24.0`
 * (yalesites-project releases).
 */
const RELEASE_PROMOTION_PATTERNS = [/^develop$/, /^v\d[\d.]*$/, /^release[/-]/i];

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

const PULL_NUMBER_PATTERNS = [/^Merge pull request #(\d+)\b/, /\(#(\d+)\)\s*$/];

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
 * @param {{action?: string, labelName?: string, merged?: boolean, baseRef?: string}} event
 * @returns {string|null} The target status, or null when the event is not one we act on.
 */
function resolveTargetStatus({ action, labelName, merged, baseRef } = {}) {
  if (action === 'labeled') {
    return (labelName || '').toLowerCase() === NEEDS_REVIEW_LABEL ? STATUS_IN_REVIEW : null;
  }

  if (action === 'closed' && merged) {
    if (baseRef === 'develop') {
      return STATUS_READY_FOR_RELEASE;
    }
    if (baseRef === 'main' || baseRef === 'master') {
      return STATUS_DONE;
    }
  }

  return null;
}

/**
 * Whether a head branch promotes a batch of merged work rather than one ticket.
 *
 * @param {string} headRef
 * @returns {boolean}
 */
function isReleasePromotion(headRef) {
  return RELEASE_PROMOTION_PATTERNS.some((pattern) => pattern.test(headRef || ''));
}

/**
 * Pulls the pull request numbers out of a list of commit messages.
 *
 * @param {string[]} commitMessages
 * @returns {number[]} Unique pull request numbers, in the order encountered.
 */
function extractMergedPullNumbers(commitMessages) {
  const numbers = new Set();

  for (const message of commitMessages || []) {
    const subject = String(message).split('\n')[0];
    for (const pattern of PULL_NUMBER_PATTERNS) {
      const match = subject.match(pattern);
      if (match) {
        numbers.add(Number(match[1]));
        break;
      }
    }
  }

  return [...numbers];
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
  extractMergedPullNumbers,
  isMissingRecordError,
  isReleasePromotion,
  resolveTargetStatus,
  resolveTicketNumber,
  shouldApplyStatus,
};
