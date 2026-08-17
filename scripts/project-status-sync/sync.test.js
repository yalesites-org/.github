const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');

const run = require('./sync');

const PROJECT_NUMBER = 6;

function makeCore() {
  const core = {
    infos: [],
    warnings: [],
    info: (message) => core.infos.push(message),
    warning: (message) => core.warnings.push(message),
  };
  return core;
}

/**
 * A github stub for the release sweep.
 *
 * `column` is what the board returns for "Ready for Release (in dev)", `pulls`
 * maps a ticket to its cross-referenced pull requests, and `shipped` is the set
 * of `repo#number` whose merge commits have reached production.
 */
function makeSweepGithub({ column = [], pulls = {}, shipped = new Set() } = {}) {
  const github = {
    mutations: [],
    compares: [],
    graphql: async (query, variables) => {
      if (query.includes('updateProjectV2ItemFieldValue')) {
        github.mutations.push(variables);
        return {};
      }

      if (query.includes('projectV2(number: $number)')) {
        return {
          organization: {
            projectV2: {
              id: 'PROJECT_1',
              field: {
                id: 'FIELD_1',
                options: [
                  { id: 'opt-ready', name: 'Ready for Release (in dev)' },
                  { id: 'opt-done', name: 'Done' },
                ],
              },
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: column,
              },
            },
          },
        };
      }

      if (query.includes('CROSS_REFERENCED_EVENT')) {
        const nodes = (pulls[variables.number] || []).map((pull) => ({ source: pull }));
        return { repository: { issue: { timelineItems: { nodes } } } };
      }

      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    },
    rest: {
      repos: {
        compareCommitsWithBasehead: async ({ owner, repo, basehead }) => {
          github.compares.push(`${owner}/${repo} ${basehead}`);
          const sha = basehead.split('...')[1];
          return { data: { ahead_by: shipped.has(sha) ? 0 : 3 } };
        },
      },
    },
  };
  return github;
}

/** A board item at "Ready for Release (in dev)" for `ticket`. */
function readyItem(ticket) {
  return {
    id: `ITEM_${ticket}`,
    fieldValueByName: { name: 'Ready for Release (in dev)' },
    content: { number: ticket, repository: { nameWithOwner: 'yalesites-org/YaleSites-Internal' } },
  };
}

/** A merged cross-referenced pull request. */
function mergedPull(repository, number, sha) {
  return {
    number,
    merged: true,
    mergeCommit: { oid: sha },
    repository: { nameWithOwner: repository },
  };
}

/**
 * A github stub that records GraphQL calls and answers the issue lookup with a
 * single board item at `currentStatus`.
 */
function makeGithub({ currentStatus = 'In progress', issueExists = true } = {}) {
  const github = {
    mutations: [],
    graphql: async (query, variables) => {
      if (query.includes('updateProjectV2ItemFieldValue')) {
        github.mutations.push(variables);
        return {};
      }

      if (!issueExists) {
        // The shape Octokit throws for a number that is not an issue.
        throw Object.assign(new Error('Could not resolve to an Issue with the number of 2230.'), {
          errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'] }],
        });
      }

      return {
        repository: {
          issue: {
            title: 'A ticket',
            projectItems: {
              nodes: [
                {
                  id: 'ITEM_1',
                  project: {
                    id: 'PROJECT_1',
                    number: PROJECT_NUMBER,
                    title: 'YaleSites Board',
                    field: {
                      id: 'FIELD_1',
                      options: [
                        { id: 'opt-in-review', name: 'In review' },
                        { id: 'opt-ready', name: 'Ready for Release (in dev)' },
                        { id: 'opt-done', name: 'Done' },
                      ],
                    },
                  },
                  fieldValueByName: currentStatus ? { name: currentStatus } : null,
                },
              ],
            },
          },
        },
      };
    },
  };
  return github;
}

function makeContext({ action, label, pullRequest }) {
  return {
    repo: { owner: 'yalesites-org', repo: 'yalesites-project' },
    payload: {
      action,
      label: label ? { name: label } : undefined,
      pull_request: pullRequest,
    },
  };
}

function makePullRequest(overrides = {}) {
  return {
    number: 1469,
    title: '1550: Bug: Beacon system instructions treat the recommended length as a maximum',
    body: 'References yalesites-org/YaleSites-Internal#1550',
    merged: true,
    base: { ref: 'develop', sha: 'basesha' },
    head: { ref: '1550-beacon-soft-cap-instructions' },
    merge_commit_sha: 'mergesha',
    ...overrides,
  };
}

/** The platform release: yalesites-project v2260 -> master. */
function releaseContext() {
  return makeContext({
    action: 'closed',
    pullRequest: makePullRequest({
      title: 'Release v2.26.0',
      body: '',
      base: { ref: 'master', sha: 'basesha' },
      head: { ref: 'v2260' },
    }),
  });
}

describe('sync', () => {
  beforeEach(() => {
    process.env.INTERNAL_OWNER = 'yalesites-org';
    process.env.INTERNAL_REPO = 'YaleSites-Internal';
    process.env.PROJECT_NUMBER = String(PROJECT_NUMBER);
    process.env.PRODUCTION_REPO = 'yalesites-project';
    process.env.ALLOWED_REPOS = 'yalesites-org/yalesites-project\nyalesites-org/atomic';
    process.env.PROJECT_ORG = 'yalesites-org';
    process.env.RELEASE_BRANCHES = [
      'yalesites-org/yalesites-project=master',
      'yalesites-org/atomic=main',
      'yalesites-org/component-library-twig=main',
      'yalesites-org/tokens=main',
    ].join('\n');
    process.env.DRY_RUN = 'false';
  });

  it('refuses to touch the board for a repo that is not on the allow list', async () => {
    // The reusable workflow lives in a public repo, so any repo on GitHub can
    // call it. Without this guard only the org secret's visibility setting
    // would stand between an unrelated repo and the board.
    process.env.ALLOWED_REPOS = 'yalesites-org/atomic';
    const github = makeGithub();
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({ action: 'closed', pullRequest: makePullRequest() }),
    });

    assert.equal(github.mutations.length, 0);
    assert.match(core.warnings[0], /not on this workflow's allow list/);
  });

  it('sets Ready for Release when a ticketed PR merges to develop', async () => {
    const github = makeGithub();
    const core = makeCore();

    await run({ github, core, context: makeContext({ action: 'closed', pullRequest: makePullRequest() }) });

    assert.equal(github.mutations.length, 1);
    assert.equal(github.mutations[0].optionId, 'opt-ready');
  });

  it('sets In review when the needs review label is added', async () => {
    const github = makeGithub();
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'labeled',
        label: 'needs review',
        pullRequest: makePullRequest({ merged: false }),
      }),
    });

    assert.equal(github.mutations.length, 1);
    assert.equal(github.mutations[0].optionId, 'opt-in-review');
  });

  it('does not drag a shipped ticket back to In review', async () => {
    const github = makeGithub({ currentStatus: 'Ready for Release (in dev)' });
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'labeled',
        label: 'needs review',
        pullRequest: makePullRequest({ merged: false }),
      }),
    });

    assert.equal(github.mutations.length, 0);
  });

  it('warns and does nothing when the PR names no ticket', async () => {
    const github = makeGithub();
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'closed',
        pullRequest: makePullRequest({
          title: 'Bump atomic to v1.81.0',
          body: 'Bumps the atomic dependency.',
          head: { ref: 'bump-atomic-1810' },
        }),
      }),
    });

    assert.equal(github.mutations.length, 0);
    assert.equal(core.warnings.length, 1);
    assert.match(core.warnings[0], /Could not work out which/);
  });

  it('warns and does nothing when the parsed number is not a real ticket', async () => {
    const github = makeGithub({ issueExists: false });
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'closed',
        pullRequest: makePullRequest({
          title: '',
          body: '',
          base: { ref: 'develop', sha: 'basesha' },
          head: { ref: '99999-a-number-that-is-not-a-ticket' },
        }),
      }),
    });

    assert.equal(github.mutations.length, 0);
    assert.match(core.warnings[0], /does not exist/);
  });

  it('does nothing for a PR closed without merging', async () => {
    const github = makeGithub();
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'closed',
        pullRequest: makePullRequest({ merged: false }),
      }),
    });

    assert.equal(github.mutations.length, 0);
    assert.equal(core.warnings.length, 0);
  });

  it('makes no changes in dry run mode', async () => {
    process.env.DRY_RUN = 'true';
    const github = makeGithub();
    const core = makeCore();

    await run({ github, core, context: makeContext({ action: 'closed', pullRequest: makePullRequest() }) });

    assert.equal(github.mutations.length, 0);
    assert.ok(core.infos.some((message) => message.startsWith('[dry run]')));
  });

  it('keeps going when one ticket update throws', async () => {
    const github = makeGithub();
    github.graphql = async () => {
      throw new Error('boom');
    };
    const core = makeCore();

    await run({ github, core, context: makeContext({ action: 'closed', pullRequest: makePullRequest() }) });

    assert.match(core.warnings[0], /Could not update #1550: boom/);
  });

  it('marks a ticket Done when every merged PR has reached production', async () => {
    const github = makeSweepGithub({
      column: [readyItem(1239)],
      pulls: { 1239: [mergedPull('yalesites-org/component-library-twig', 647, 'clt-sha')] },
      shipped: new Set(['clt-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 1);
    assert.equal(github.mutations[0].optionId, 'opt-done');
    assert.equal(github.mutations[0].itemId, 'ITEM_1239');
  });

  it('marks a companion-only ticket Done - the gap this sweep exists to close', async () => {
    // Ticket 1266 shipped in v2.23.0 with only an atomic PR. The old commit-range
    // fan-out walked yalesites-project only, so it never saw this ticket and a
    // human had to move it by hand.
    const github = makeSweepGithub({
      column: [readyItem(1266)],
      pulls: { 1266: [mergedPull('yalesites-org/atomic', 463, 'atomic-sha')] },
      shipped: new Set(['atomic-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 1);
    assert.equal(github.compares[0], 'yalesites-org/atomic main...atomic-sha');
  });

  it('leaves a ticket alone when one of its repos has not shipped yet', async () => {
    // The CLT half made the RC but the yalesites-project half merged to develop
    // afterwards, so the ticket is only half shipped.
    const github = makeSweepGithub({
      column: [readyItem(1299)],
      pulls: {
        1299: [
          mergedPull('yalesites-org/component-library-twig', 648, 'clt-sha'),
          mergedPull('yalesites-org/yalesites-project', 1295, 'ysp-sha'),
        ],
      },
      shipped: new Set(['clt-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 0);
  });

  it('ignores unmerged pull requests', async () => {
    // Tickets 1266 and 1311 both have abandoned yalesites-project PRs and
    // shipped anyway, so an unmerged PR must not hold a ticket open.
    const github = makeSweepGithub({
      column: [readyItem(1311)],
      pulls: {
        1311: [
          mergedPull('yalesites-org/atomic', 465, 'atomic-sha'),
          { number: 1297, merged: false, mergeCommit: null, repository: { nameWithOwner: 'yalesites-org/yalesites-project' } },
        ],
      },
      shipped: new Set(['atomic-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 1);
    assert.equal(github.mutations[0].optionId, 'opt-done');
  });

  it('ignores references from repos with no release process', async () => {
    // Ticket 1349 is cross-referenced from yalesites-claude-plugins, which never
    // promotes to a release branch. It must not gate the ticket.
    const github = makeSweepGithub({
      column: [readyItem(1349)],
      pulls: {
        1349: [
          mergedPull('yalesites-org/atomic', 470, 'atomic-sha'),
          mergedPull('yalesites-org/yalesites-claude-plugins', 6, 'plugins-sha'),
        ],
      },
      shipped: new Set(['atomic-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 1);
    assert.deepEqual(github.compares, ['yalesites-org/atomic main...atomic-sha']);
  });

  it('only considers tickets already at Ready for Release', async () => {
    // Work can be merged on a ticket that is deliberately still open because
    // more is coming. A shipped pull request must not complete it.
    const inProgress = {
      id: 'ITEM_9999',
      fieldValueByName: { name: 'In progress' },
      content: { number: 9999, repository: { nameWithOwner: 'yalesites-org/YaleSites-Internal' } },
    };
    const github = makeSweepGithub({
      column: [inProgress],
      pulls: { 9999: [mergedPull('yalesites-org/atomic', 1, 'atomic-sha')] },
      shipped: new Set(['atomic-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 0);
    assert.equal(github.compares.length, 0);
  });

  it('skips a ticket with no merged pull request in any release repo', async () => {
    const github = makeSweepGithub({ column: [readyItem(1500)], pulls: {} });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 0);
    assert.ok(core.infos.some((m) => m.includes('no merged pull request in a release repo')));
  });

  it('treats an unresolvable comparison as not shipped rather than failing', async () => {
    const github = makeSweepGithub({
      column: [readyItem(1266)],
      pulls: { 1266: [mergedPull('yalesites-org/atomic', 463, 'gone-sha')] },
    });
    github.rest.repos.compareCommitsWithBasehead = async () => {
      throw new Error('Not Found');
    };
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 0);
    assert.match(core.warnings[0], /Could not tell whether/);
  });

  it('changes nothing on a release in dry run mode', async () => {
    process.env.DRY_RUN = 'true';
    const github = makeSweepGithub({
      column: [readyItem(1239)],
      pulls: { 1239: [mergedPull('yalesites-org/component-library-twig', 647, 'clt-sha')] },
      shipped: new Set(['clt-sha']),
    });
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.equal(github.mutations.length, 0);
    assert.ok(core.infos.some((m) => m.startsWith('[dry run]')));
  });

  it('never lets a failure escape and fail the release', async () => {
    const github = makeSweepGithub({ column: [readyItem(1239)] });
    github.graphql = async () => {
      throw new Error('502 Bad Gateway');
    };
    const core = makeCore();

    await run({ github, core, context: releaseContext() });

    assert.match(core.warnings[0], /did not complete: 502 Bad Gateway/);
  });
});
