/**
 * Entry point for the project status sync workflow.
 *
 * Called from `actions/github-script` in
 * `.github/workflows/project-status-sync.yml`. Everything that can be decided
 * without the GitHub API lives in status-rules.js and is unit tested there.
 */

const {
  STATUS_DONE,
  STATUS_READY_FOR_RELEASE,
  isAllowedCaller,
  isContainedInProduction,
  isMissingRecordError,
  parseReleaseBranches,
  resolveTargetStatus,
  resolveTicketNumber,
  shouldApplyStatus,
} = require('./status-rules');

const ISSUE_PROJECT_STATUS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        projectItems(first: 20) {
          nodes {
            id
            project {
              id
              number
              title
              field(name: "Status") {
                ... on ProjectV2SingleSelectField {
                  id
                  options { id name }
                }
              }
            }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
`;

/**
 * Every ticket sitting in one column of the board, with its project item ids so
 * the status can be written back without a second lookup.
 */
const BOARD_COLUMN_QUERY = `
  query($org: String!, $number: Int!, $cursor: String) {
    organization(login: $org) {
      projectV2(number: $number) {
        id
        field(name: "Status") {
          ... on ProjectV2SingleSelectField {
            id
            options { id name }
          }
        }
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            content {
              ... on Issue {
                number
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The pull requests that reference a ticket, in any repo.
 *
 * Our PR bodies carry `References yalesites-org/YaleSites-Internal#1234`, which
 * GitHub records as a cross-reference even though it is not a closing keyword.
 * That makes this more reliable than re-parsing branch names: ticket 1265's pull
 * request branch was `drupal-10-6-10-update`, with no ticket number in it at
 * all, and the cross-reference still finds it.
 */
const TICKET_PULL_REQUESTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  number
                  merged
                  mergeCommit { oid }
                  repository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const SET_STATUS_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
`;

/** Every board item currently sitting in one column, plus the ids to write with. */
async function fetchColumn({ github, options, status }) {
  const { org, projectNumber } = options;
  const items = [];
  let project = null;
  let cursor = null;

  do {
    const result = await github.graphql(BOARD_COLUMN_QUERY, {
      org,
      number: projectNumber,
      cursor,
    });

    project = result.organization.projectV2;
    for (const item of project.items.nodes) {
      const current = item.fieldValueByName ? item.fieldValueByName.name : null;
      if (current && current.toLowerCase() === status.toLowerCase() && item.content) {
        items.push(item);
      }
    }

    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (cursor);

  return { project, items };
}

/** The merged pull requests referencing a ticket, limited to the release repos. */
async function fetchShippablePullRequests({ github, options, ticket }) {
  const { internalOwner, internalRepo, releaseBranches } = options;

  const result = await github.graphql(TICKET_PULL_REQUESTS_QUERY, {
    owner: internalOwner,
    repo: internalRepo,
    number: ticket,
  });

  const seen = new Set();
  const pullRequests = [];

  for (const node of result.repository.issue.timelineItems.nodes) {
    const pull = node.source;
    if (!pull || !pull.merged || !pull.mergeCommit) {
      continue;
    }

    const repository = pull.repository.nameWithOwner;
    const key = `${repository}#${pull.number}`;
    if (seen.has(key) || !releaseBranches.has(repository.toLowerCase())) {
      continue;
    }

    seen.add(key);
    pullRequests.push({ repository, number: pull.number, sha: pull.mergeCommit.oid });
  }

  return pullRequests;
}

/** Whether a merge commit has reached its repo's production branch. */
async function hasShipped({ github, core, options, pull }) {
  const [owner, repo] = pull.repository.split('/');
  const branch = options.releaseBranches.get(pull.repository.toLowerCase());

  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${branch}...${pull.sha}`,
    });
    return isContainedInProduction({ aheadBy: data.ahead_by });
  } catch (error) {
    // A merge commit can vanish if its branch was deleted and garbage collected.
    // Treat that as "not shipped" rather than aborting the whole sweep.
    core.warning(
      `Could not tell whether ${pull.repository}#${pull.number} is in ${branch}: ${error.message}`,
    );
    return false;
  }
}

/**
 * Marks every ticket whose work has reached production as Done.
 *
 * Runs when the platform repo releases. Only tickets already sitting at "Ready
 * for Release (in dev)" are considered: a ticket still In progress or In review
 * has more work to come, so a shipped pull request must not complete it.
 *
 * A ticket ships when every merged pull request it has *in a release repo* is
 * contained in that repo's production branch. Requiring every one of them —
 * rather than any — is what stops a ticket being called Done when its
 * component-library-twig half made the RC but its yalesites-project half merged
 * to develop afterwards. Unmerged pull requests are ignored: tickets 1266 and
 * 1311 both have abandoned yalesites-project pull requests and shipped anyway.
 */
async function markShippedTicketsDone({ github, core, options }) {
  const { project, items } = await fetchColumn({
    github,
    options,
    status: STATUS_READY_FOR_RELEASE,
  });

  core.info(`${items.length} ticket(s) sitting at "${STATUS_READY_FOR_RELEASE}".`);

  for (const item of items) {
    const ticket = item.content.number;
    const pullRequests = await fetchShippablePullRequests({ github, options, ticket });

    if (pullRequests.length === 0) {
      core.info(`#${ticket}: no merged pull request in a release repo - leaving it alone.`);
      continue;
    }

    const shipped = [];
    for (const pull of pullRequests) {
      if (!(await hasShipped({ github, core, options, pull }))) {
        core.info(
          `#${ticket}: ${pull.repository}#${pull.number} has not reached production yet - ` +
            'leaving the ticket at Ready for Release.',
        );
        shipped.length = 0;
        break;
      }
      shipped.push(`${pull.repository}#${pull.number}`);
    }

    if (shipped.length === 0) {
      continue;
    }

    await setItemStatus({
      github,
      core,
      project,
      item,
      targetStatus: STATUS_DONE,
      options,
      reason: shipped.join(', '),
    });
  }
}

/** Writes a status onto a board item we already hold the ids for. */
async function setItemStatus({ github, core, project, item, targetStatus, options, reason }) {
  const ticket = item.content.number;
  const option = project.field.options.find(
    (candidate) => candidate.name.toLowerCase() === targetStatus.toLowerCase(),
  );

  if (!option) {
    core.warning(`The board has no "${targetStatus}" Status option. Skipping #${ticket}.`);
    return;
  }

  if (options.dryRun) {
    core.info(`[dry run] Would set #${ticket} to "${targetStatus}" (shipped in ${reason}).`);
    return;
  }

  await github.graphql(SET_STATUS_MUTATION, {
    projectId: project.id,
    itemId: item.id,
    fieldId: project.field.id,
    optionId: option.id,
  });
  core.info(`Set #${ticket} to "${targetStatus}" (shipped in ${reason}).`);
}

/**
 * Sets a single ticket's Status on the board, refusing to move it backwards.
 */
async function applyStatusToTicket({ github, core, ticket, targetStatus, options }) {
  const { internalOwner, internalRepo, projectNumber, dryRun } = options;

  let result;
  try {
    result = await github.graphql(ISSUE_PROJECT_STATUS_QUERY, {
      owner: internalOwner,
      repo: internalRepo,
      number: ticket,
    });
  } catch (error) {
    if (!isMissingRecordError(error)) {
      throw error;
    }
    result = { repository: { issue: null } };
  }

  const issue = result.repository.issue;
  if (!issue) {
    core.warning(
      `${internalOwner}/${internalRepo}#${ticket} does not exist - the number parsed from this ` +
        'pull request is probably not a ticket. Skipping.',
    );
    return;
  }

  const items = issue.projectItems.nodes.filter((item) => item.project.number === projectNumber);
  if (items.length === 0) {
    core.warning(
      `${internalOwner}/${internalRepo}#${ticket} is not on project #${projectNumber}. Skipping.`,
    );
    return;
  }

  for (const item of items) {
    const statusField = item.project.field;
    if (!statusField) {
      core.warning(`Project "${item.project.title}" has no Status field. Skipping.`);
      continue;
    }

    const currentStatus = item.fieldValueByName ? item.fieldValueByName.name : null;
    if (!shouldApplyStatus(currentStatus, targetStatus)) {
      core.info(
        `#${ticket} is already at "${currentStatus}" - not moving it to "${targetStatus}".`,
      );
      continue;
    }

    const option = statusField.options.find(
      (candidate) => candidate.name.toLowerCase() === targetStatus.toLowerCase(),
    );
    if (!option) {
      core.warning(
        `Project "${item.project.title}" has no "${targetStatus}" Status option ` +
          `(available: ${statusField.options.map((o) => o.name).join(', ')}). Skipping.`,
      );
      continue;
    }

    if (dryRun) {
      core.info(`[dry run] Would set #${ticket} from "${currentStatus}" to "${targetStatus}".`);
      continue;
    }

    await github.graphql(SET_STATUS_MUTATION, {
      projectId: item.project.id,
      itemId: item.id,
      fieldId: statusField.id,
      optionId: option.id,
    });
    core.info(`Set #${ticket} from "${currentStatus}" to "${targetStatus}".`);
  }
}

/** Works out which tickets this event affects and moves each one. */
async function sync({ github, context, core }) {
  const options = {
    org: process.env.PROJECT_ORG,
    internalOwner: process.env.INTERNAL_OWNER,
    internalRepo: process.env.INTERNAL_REPO,
    projectNumber: Number(process.env.PROJECT_NUMBER),
    productionRepo: process.env.PRODUCTION_REPO,
    releaseBranches: parseReleaseBranches(process.env.RELEASE_BRANCHES),
    dryRun: process.env.DRY_RUN === 'true',
  };

  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!isAllowedCaller(repository, process.env.ALLOWED_REPOS)) {
    core.warning(
      `${repository} is not on this workflow's allow list, so it may not change the board. ` +
        'Add it to the allowed_repos input if that is wrong.',
    );
    return;
  }

  const payload = context.payload.pull_request;
  if (!payload) {
    core.warning('No pull request in the event payload - nothing to do.');
    return;
  }

  const targetStatus = resolveTargetStatus({
    action: context.payload.action,
    labelName: context.payload.label ? context.payload.label.name : null,
    merged: payload.merged,
    baseRef: payload.base.ref,
    repo: context.repo.repo,
    productionRepo: options.productionRepo,
  });

  if (!targetStatus) {
    core.info(
      `No status change applies to this event (action "${context.payload.action}", base ` +
        `"${payload.base.ref}") - nothing to do.`,
    );
    return;
  }

  core.info(`Target status: "${targetStatus}"${options.dryRun ? ' (dry run)' : ''}`);

  // The platform release is not about the release pull request's own ticket - it
  // ships everything waiting in the dev column, across all four repos. Sweep the
  // board instead of trying to read tickets out of this one pull request.
  if (targetStatus === STATUS_DONE) {
    core.info(
      `${repository} released to "${payload.base.ref}" - marking every shipped ticket Done.`,
    );
    await markShippedTicketsDone({ github, core, options });
    return;
  }

  const ticket = resolveTicketNumber({
    headRef: payload.head.ref,
    title: payload.title,
    body: payload.body,
  });
  const tickets = ticket ? [ticket] : [];

  if (tickets.length === 0) {
    core.warning(
      `Could not work out which ${options.internalOwner}/${options.internalRepo} ticket this pull ` +
        'request belongs to. Expected a branch named "1234-description", a title starting ' +
        '"1234:", or a body line "References yalesites-org/YaleSites-Internal#1234". ' +
        'Doing nothing.',
    );
    return;
  }

  for (const ticket of tickets) {
    try {
      await applyStatusToTicket({ github, core, ticket, targetStatus, options });
    } catch (error) {
      // One unreachable or malformed ticket must not fail the run or stop the rest.
      core.warning(`Could not update #${ticket}: ${error.message}`);
    }
  }
}

/**
 * @param {{github: object, context: object, core: object}} scriptContext
 *   The objects `actions/github-script` provides.
 */
module.exports = async function run({ github, context, core }) {
  try {
    await sync({ github, context, core });
  } catch (error) {
    // Board bookkeeping must never fail a merge. The release fan-out in
    // particular makes hundreds of sequential API calls, so a single 502 or a
    // secondary rate limit would otherwise put a red X on a release pull
    // request.
    core.warning(`Project status sync did not complete: ${error.message}`);
  }
};
