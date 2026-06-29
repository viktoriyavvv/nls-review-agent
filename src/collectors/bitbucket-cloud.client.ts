import { BitbucketConfig } from '../config/types';
import {
  BitbucketClient,
  BitbucketRepoTarget,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetails,
  PullRequestDiffStat,
  PullRequestSearchResult,
} from './bitbucket.types';

/**
 * Bitbucket Cloud client — TODO placeholder.
 *
 * Implements the same BitbucketClient interface as the Data Center client so it
 * can be swapped in later. Cloud uses a different API shape:
 *   https://api.bitbucket.org/2.0/repositories/{workspace}/{repoSlug}/pullrequests
 * Auth is typically Basic (username + app password) or Bearer (OAuth/Access token).
 *
 * Not implemented in the MVP — every method throws.
 */
export class BitbucketCloudClient implements BitbucketClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private cfg: BitbucketConfig) {}

  private notImplemented(): never {
    throw new Error(
      'Bitbucket Cloud client is not implemented yet (TODO). ' +
        'Set bitbucket.type: "datacenter" in config/repos.yml, or implement BitbucketCloudClient.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findPullRequestByIssueKey(
    _params: BitbucketRepoTarget & { issueKey: string },
  ): Promise<PullRequestSearchResult> {
    return this.notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPullRequest(_params: BitbucketRepoTarget & { prId: number }): Promise<PullRequestDetails> {
    return this.notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPullRequestComments(
    _params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestComment[]> {
    return this.notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPullRequestCommits(
    _params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestCommit[]> {
    return this.notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPullRequestDiffStat(
    _params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestDiffStat[]> {
    return this.notImplemented();
  }
}
