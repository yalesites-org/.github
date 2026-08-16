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

describe('sync', () => {
  beforeEach(() => {
    process.env.INTERNAL_OWNER = 'yalesites-org';
    process.env.INTERNAL_REPO = 'YaleSites-Internal';
    process.env.PROJECT_NUMBER = String(PROJECT_NUMBER);
    process.env.DRY_RUN = 'false';
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
          base: { ref: 'master', sha: 'basesha' },
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

  it('marks every ticket in a release promotion Done', async () => {
    const github = makeGithub({ currentStatus: 'Ready for Release (in dev)' });
    github.paginate = async () => [
      { commit: { message: 'Merge pull request #1469 from yalesites-org/1550-beacon-soft-cap' } },
      { commit: { message: 'Merge pull request #1471 from yalesites-org/bump-atomic-1810' } },
    ];
    github.rest = {
      pulls: {
        get: async (_options) => ({
          data: { head: { ref: '1550-beacon-soft-cap' }, title: '1550: Beacon', body: '' },
        }),
      },
      repos: { compareCommits: () => {} },
    };
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'closed',
        pullRequest: makePullRequest({
          title: 'RC Update',
          body: '',
          base: { ref: 'main', sha: 'basesha' },
          head: { ref: 'develop' },
        }),
      }),
    });

    assert.equal(github.mutations.length, 1);
    assert.equal(github.mutations[0].optionId, 'opt-done');
  });

  it('never lets a failure escape and fail the workflow run', async () => {
    // The release fan-out makes hundreds of sequential API calls, so a single
    // transient error must not put a red X on a release pull request.
    const github = makeGithub();
    github.paginate = async () => {
      throw new Error('502 Bad Gateway');
    };
    github.rest = { repos: { compareCommits: () => {} } };
    const core = makeCore();

    await run({
      github,
      core,
      context: makeContext({
        action: 'closed',
        pullRequest: makePullRequest({
          title: 'RC Update',
          body: '',
          base: { ref: 'main', sha: 'basesha' },
          head: { ref: 'develop' },
        }),
      }),
    });

    assert.match(core.warnings[0], /did not complete: 502 Bad Gateway/);
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
});
