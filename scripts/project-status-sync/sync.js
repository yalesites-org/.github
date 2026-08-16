/**
 * Entry point for the project status sync workflow.
 *
 * Called from `actions/github-script` in
 * `.github/workflows/project-status-sync.yml`. Everything that can be decided
 * without the GitHub API lives in status-rules.js and is unit tested there.
 */

const {
  STATUS_DONE,
  extractMergedPullNumbers,
  isMissingRecordError,
  isReleasePromotion,
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

/**
 * Collects the tickets a merged release promotion carries, by walking the pull
 * requests it brought along.
 */
async function resolveTicketsFromReleasePromotion({ github, core, pullRequest }) {
  const { owner, repo } = pullRequest.repository;

  const commits = await github.paginate(
    github.rest.repos.compareCommits,
    {
      owner,
      repo,
      base: pullRequest.baseSha,
      head: pullRequest.mergeCommitSha,
      per_page: 100,
    },
    (response) => response.data.commits,
  );

  const pullNumbers = extractMergedPullNumbers(commits.map((commit) => commit.commit.message));
  core.info(`Release promotion carries ${commits.length} commits across ${pullNumbers.length} pull requests.`);

  const tickets = new Map();

  for (const pullNumber of pullNumbers) {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const ticket = resolveTicketNumber({
      headRef: data.head.ref,
      title: data.title,
      body: data.body,
    });

    if (ticket) {
      tickets.set(ticket, pullNumber);
      core.info(`  #${pullNumber} -> ticket ${ticket}`);
    } else {
      core.info(`  #${pullNumber} (${data.title}) has no linked ticket - skipping`);
    }
  }

  return [...tickets.keys()];
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
    internalOwner: process.env.INTERNAL_OWNER,
    internalRepo: process.env.INTERNAL_REPO,
    projectNumber: Number(process.env.PROJECT_NUMBER),
    dryRun: process.env.DRY_RUN === 'true',
  };

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
  });

  if (!targetStatus) {
    core.info(
      `No status change applies to this event (action "${context.payload.action}", base ` +
        `"${payload.base.ref}") - nothing to do.`,
    );
    return;
  }

  core.info(`Target status: "${targetStatus}"${options.dryRun ? ' (dry run)' : ''}`);

  const pullRequest = {
    repository: context.repo,
    baseSha: payload.base.sha,
    mergeCommitSha: payload.merge_commit_sha,
  };

  let tickets;
  if (targetStatus === STATUS_DONE && isReleasePromotion(payload.head.ref)) {
    core.info(`"${payload.head.ref}" is a release promotion - collecting every ticket it carries.`);
    tickets = await resolveTicketsFromReleasePromotion({ github, core, pullRequest });
  } else {
    const ticket = resolveTicketNumber({
      headRef: payload.head.ref,
      title: payload.title,
      body: payload.body,
    });
    tickets = ticket ? [ticket] : [];
  }

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
