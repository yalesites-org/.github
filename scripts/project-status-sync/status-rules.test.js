const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
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
} = require('./status-rules');

// Fixtures below are copied verbatim from real merged pull requests in
// yalesites-project, atomic, and component-library-twig so the parser is tested
// against the conventions those repos actually produce.
describe('resolveTicketNumber', () => {
  it('reads the ticket from the standard branch name', () => {
    assert.equal(
      resolveTicketNumber({
        headRef: '1550-beacon-soft-cap-instructions',
        title: '1550: Bug: Beacon system instructions treat the recommended length as a maximum',
        body: 'References yalesites-org/YaleSites-Internal#1550',
      }),
      1550,
    );
  });

  it('reads the ticket from a hotfix branch name', () => {
    assert.equal(
      resolveTicketNumber({ headRef: 'hotfix/456-broken-thing', title: '', body: '' }),
      456,
    );
  });

  it('falls back to the PR title convention when the branch has no number', () => {
    assert.equal(
      resolveTicketNumber({ headRef: 'fix-the-thing', title: '1543: RC: Resource external source link', body: '' }),
      1543,
    );
  });

  it('falls back to the qualified References line in the body', () => {
    assert.equal(
      resolveTicketNumber({
        headRef: 'fix-the-thing',
        title: 'Fix the thing',
        body: 'Some description\n\nReferences yalesites-org/YaleSites-Internal#1497\n',
      }),
      1497,
    );
  });

  it('accepts an unqualified YaleSites-Internal reference', () => {
    assert.equal(
      resolveTicketNumber({ headRef: 'x', title: 'x', body: 'Related to YaleSites-Internal#1234' }),
      1234,
    );
  });

  it('ignores a bare closing keyword, which numbers an issue in the PR own repo', () => {
    // yalesites-project is at ~#1475 and YaleSites-Internal at ~#1555, so a bare
    // "#1274" would resolve to a real but completely unrelated ticket.
    assert.equal(resolveTicketNumber({ headRef: 'x', title: 'x', body: 'Fixes #1274' }), null);
  });

  it('ignores the release hotfix branch, whose number is a version', () => {
    // hotfix/2230-hotfix-1 is version 2.23.0, not ticket 2230.
    assert.equal(
      resolveTicketNumber({ headRef: 'hotfix/2230-hotfix-1', title: 'Hotfix 1: 2.23.0', body: '' }),
      null,
    );
  });

  it('still reads a real ticket out of a hotfix branch', () => {
    assert.equal(
      resolveTicketNumber({ headRef: 'hotfix/1394-campus-groups-sync-fix', title: '', body: '' }),
      1394,
    );
  });

  it('returns null for a dependency bump with no ticket', () => {
    assert.equal(
      resolveTicketNumber({
        headRef: 'bump-atomic-1810',
        title: 'Bump atomic to v1.81.0',
        body: 'Bumps the `yalesites-org/atomic` dependency to v1.81.0.',
      }),
      null,
    );
  });

  it('returns null for an RC promotion PR', () => {
    assert.equal(resolveTicketNumber({ headRef: 'develop', title: 'RC Update', body: '' }), null);
  });

  it('tolerates a null body and title', () => {
    assert.equal(resolveTicketNumber({ headRef: 'no-number-here', title: null, body: null }), null);
  });

  it('does not read a version number out of the middle of a branch name', () => {
    assert.equal(
      resolveTicketNumber({ headRef: 'cve-allowlist-6-29-26', title: 'Add advisories', body: '' }),
      null,
    );
  });
});

describe('resolveTargetStatus', () => {
  it('moves the ticket to In review when the needs review label is added', () => {
    assert.equal(
      resolveTargetStatus({ action: 'labeled', labelName: 'needs review' }),
      STATUS_IN_REVIEW,
    );
  });

  it('matches the needs review label case-insensitively', () => {
    assert.equal(
      resolveTargetStatus({ action: 'labeled', labelName: 'Needs Review' }),
      STATUS_IN_REVIEW,
    );
  });

  it('ignores other labels', () => {
    assert.equal(resolveTargetStatus({ action: 'labeled', labelName: 'needs work' }), null);
    assert.equal(resolveTargetStatus({ action: 'labeled', labelName: 'pass code review' }), null);
  });

  it('moves the ticket to Ready for Release when merged to develop', () => {
    assert.equal(
      resolveTargetStatus({ action: 'closed', merged: true, baseRef: 'develop' }),
      STATUS_READY_FOR_RELEASE,
    );
  });

  it('moves the ticket to Done when the platform repo merges to main or master', () => {
    const release = {
      action: 'closed',
      merged: true,
      repo: 'yalesites-project',
      productionRepo: 'yalesites-project',
    };
    assert.equal(resolveTargetStatus({ ...release, baseRef: 'main' }), STATUS_DONE);
    assert.equal(resolveTargetStatus({ ...release, baseRef: 'master' }), STATUS_DONE);
  });

  it('does NOT mark tickets Done on an atomic or component-library-twig RC promotion', () => {
    // Verified against the board: 1529, 1532, 1536 and 1537 were all carried by
    // the 2026-08-14 component-library-twig develop -> main RC Update, and all
    // four still sit at "Ready for Release (in dev)". A companion RC is an
    // intermediate release step, not "shipped".
    for (const repo of ['atomic', 'component-library-twig']) {
      assert.equal(
        resolveTargetStatus({
          action: 'closed',
          merged: true,
          baseRef: 'main',
          repo,
          productionRepo: 'yalesites-project',
        }),
        null,
      );
    }
  });

  it('does nothing for a PR that was closed without merging', () => {
    assert.equal(resolveTargetStatus({ action: 'closed', merged: false, baseRef: 'develop' }), null);
  });

  it('does nothing for a stacked PR merged into another feature branch', () => {
    assert.equal(
      resolveTargetStatus({ action: 'closed', merged: true, baseRef: '1362-wave-7-chrome-sdc' }),
      null,
    );
  });

  it('does nothing for an unhandled action', () => {
    assert.equal(resolveTargetStatus({ action: 'opened' }), null);
    assert.equal(resolveTargetStatus({ action: 'unlabeled', labelName: 'needs review' }), null);
  });
});

describe('isAllowedCaller', () => {
  const allowed = [
    'yalesites-org/yalesites-project',
    'yalesites-org/atomic',
    'yalesites-org/component-library-twig',
    'yalesites-org/tokens',
    'yalesites-org/YaleSites-Internal',
  ].join('\n');

  it('allows each YaleSites code repo', () => {
    for (const repository of allowed.split('\n')) {
      assert.equal(isAllowedCaller(repository, allowed), true);
    }
  });

  it('is case-insensitive, since YaleSites-Internal is mixed case', () => {
    assert.equal(isAllowedCaller('yalesites-org/yalesites-internal', allowed), true);
  });

  it('rejects any other repo in the organization', () => {
    assert.equal(isAllowedCaller('yalesites-org/ysph', allowed), false);
    assert.equal(isAllowedCaller('yalesites-org/news.yale.edu', allowed), false);
    assert.equal(isAllowedCaller('yalesites-org/.github', allowed), false);
  });

  it('rejects a repo outside the organization that guessed the path', () => {
    // The workflow lives in a public repo, so anyone on GitHub can call it.
    assert.equal(isAllowedCaller('someone-else/atomic', allowed), false);
  });

  it('rejects everything when the list is empty or missing', () => {
    assert.equal(isAllowedCaller('yalesites-org/atomic', ''), false);
    assert.equal(isAllowedCaller('yalesites-org/atomic', undefined), false);
  });

  it('tolerates a comma-separated list and stray whitespace', () => {
    assert.equal(isAllowedCaller('yalesites-org/atomic', ' yalesites-org/atomic , x/y '), true);
  });
});

describe('isMissingRecordError', () => {
  // Shape observed from the real API for a number that is not an issue:
  // {"data":{"repository":{"issue":null}},"errors":[{"type":"NOT_FOUND",...}]}
  it('recognises the NOT_FOUND error Octokit throws for a missing issue', () => {
    const error = Object.assign(new Error('Could not resolve to an Issue with the number of 2230.'), {
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'] }],
    });
    assert.equal(isMissingRecordError(error), true);
  });

  it('does not swallow other failures', () => {
    assert.equal(isMissingRecordError(new Error('Bad credentials')), false);
    assert.equal(
      isMissingRecordError(Object.assign(new Error('nope'), { errors: [{ type: 'FORBIDDEN' }] })),
      false,
    );
    assert.equal(isMissingRecordError(null), false);
  });
});

describe('shouldApplyStatus', () => {
  it('applies when the ticket has no status yet', () => {
    assert.equal(shouldApplyStatus(null, STATUS_IN_REVIEW), true);
  });

  it('applies when moving the ticket forward', () => {
    assert.equal(shouldApplyStatus('In progress', STATUS_IN_REVIEW), true);
    assert.equal(shouldApplyStatus(STATUS_IN_REVIEW, STATUS_READY_FOR_RELEASE), true);
    assert.equal(shouldApplyStatus(STATUS_READY_FOR_RELEASE, STATUS_DONE), true);
  });

  it('lets In review override Blocked, since a PR up for review means work resumed', () => {
    assert.equal(shouldApplyStatus('Blocked', STATUS_IN_REVIEW), true);
  });

  it('never moves a ticket backwards', () => {
    assert.equal(shouldApplyStatus(STATUS_READY_FOR_RELEASE, STATUS_IN_REVIEW), false);
    assert.equal(shouldApplyStatus(STATUS_DONE, STATUS_IN_REVIEW), false);
    assert.equal(shouldApplyStatus(STATUS_DONE, STATUS_READY_FOR_RELEASE), false);
  });

  it('skips a no-op re-application of the same status', () => {
    assert.equal(shouldApplyStatus(STATUS_IN_REVIEW, STATUS_IN_REVIEW), false);
  });

  it('applies when the current status is not one it knows about', () => {
    assert.equal(shouldApplyStatus('Some Custom Column', STATUS_DONE), true);
  });

  it('compares status names case-insensitively', () => {
    assert.equal(shouldApplyStatus('done', STATUS_IN_REVIEW), false);
  });
});

describe('parseReleaseBranches', () => {
  const text = [
    'yalesites-org/yalesites-project=master',
    'yalesites-org/atomic=main',
    'yalesites-org/component-library-twig=main',
    'yalesites-org/tokens=main',
  ].join('\n');

  it('maps each repo to its production branch', () => {
    const branches = parseReleaseBranches(text);
    assert.equal(branches.get('yalesites-org/yalesites-project'), 'master');
    assert.equal(branches.get('yalesites-org/atomic'), 'main');
    assert.equal(branches.get('yalesites-org/tokens'), 'main');
    assert.equal(branches.size, 4);
  });

  it('excludes repos with no release process', () => {
    // Ticket 1349 is cross-referenced from yalesites-claude-plugins, which has
    // no RC promotion. It must not gate whether the ticket has shipped.
    assert.equal(parseReleaseBranches(text).has('yalesites-org/yalesites-claude-plugins'), false);
  });

  it('ignores blank and malformed lines', () => {
    const branches = parseReleaseBranches('\n\nyalesites-org/atomic=main\ngarbage\nx=\n=y\n');
    assert.equal(branches.size, 1);
    assert.equal(branches.get('yalesites-org/atomic'), 'main');
  });

  it('returns an empty map for missing configuration', () => {
    assert.equal(parseReleaseBranches(undefined).size, 0);
  });
});

describe('isContainedInProduction', () => {
  // Verified live against the real API. Comparing productionBranch...mergeCommit:
  //   atomic main...a1b8d69 (ticket 1266, shipped)     -> behind,    ahead_by 0
  //   atomic main...<main tip>                          -> identical, ahead_by 0
  //   CLT    main...caaf2e6 (ticket 1554, post-RC)      -> diverged,  ahead_by 2
  it('treats behind as shipped', () => {
    assert.equal(isContainedInProduction({ aheadBy: 0 }), true);
  });

  it('treats a commit production does not have as not shipped', () => {
    assert.equal(isContainedInProduction({ aheadBy: 2 }), false);
    assert.equal(isContainedInProduction({ aheadBy: 1 }), false);
  });

  it('is false when the comparison could not be made', () => {
    assert.equal(isContainedInProduction({}), false);
    assert.equal(isContainedInProduction(), false);
  });
});
