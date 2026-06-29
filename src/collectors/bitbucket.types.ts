/* Shared Bitbucket abstraction. The Data Center client implements this fully;
 * the Cloud client is a stub with the same shape. */

export interface BitbucketRepoTarget {
  /** Data Center project key (required by the DC client; ignored by Cloud). */
  projectKey?: string;
  repoSlug: string;
  /** Bitbucket Cloud workspace (Cloud client; falls back to global config). */
  workspace?: string;
}

export interface PullRequestSummary {
  id: number;
  title: string;
  state: string; // OPEN | MERGED | DECLINED | ...
  description?: string;
  fromRef: {
    branch: string;
    latestCommit?: string;
  };
  toRef: {
    branch: string;
  };
  author?: string;
  url?: string;
  createdDate?: number;
  updatedDate?: number;
  raw: unknown;
}

export interface PullRequestReviewer {
  name: string;
  approved: boolean;
  status?: string; // APPROVED | UNAPPROVED | NEEDS_WORK
}

export interface PullRequestDetails extends PullRequestSummary {
  reviewers: PullRequestReviewer[];
  openTasks?: number;
  resolvedTasks?: number;
}

export interface PullRequestComment {
  id: number | string;
  /** Parent comment id when this is a reply (thread reconstruction). */
  parentId?: number | string;
  author: string;
  /** Plain-text body. (`text` is the canonical field used across the codebase.) */
  text: string;
  createdAt?: number | string;
  createdOn?: string;
  updatedOn?: string;
  deleted?: boolean;
  /** Present for inline (file-anchored) comments. */
  inline?: {
    path?: string;
    from?: number;
    to?: number;
  };
  links?: Record<string, string>;
  raw?: unknown;
}

export interface PullRequestCommit {
  id: string;
  message: string;
  author?: string;
  authorTimestamp?: number;
}

export interface PullRequestDiffStat {
  path: string;
  type: string; // ADD | MODIFY | DELETE | RENAME | COPY
}

export interface PullRequestSearchResult {
  candidates: PullRequestSummary[];
}

export interface BitbucketClient {
  findPullRequestByIssueKey(params: BitbucketRepoTarget & {
    issueKey: string;
  }): Promise<PullRequestSearchResult>;

  getPullRequest(params: BitbucketRepoTarget & {
    prId: number;
  }): Promise<PullRequestDetails>;

  getPullRequestComments(params: BitbucketRepoTarget & {
    prId: number;
  }): Promise<PullRequestComment[]>;

  getPullRequestCommits(params: BitbucketRepoTarget & {
    prId: number;
  }): Promise<PullRequestCommit[]>;

  getPullRequestDiffStat(params: BitbucketRepoTarget & {
    prId: number;
  }): Promise<PullRequestDiffStat[]>;
}

/* ------------------------- write-side (FUTURE) -------------------------
 * Intentionally NOT wired into the MVP. These are placeholder interfaces so a
 * later phase can add commenting / approvals without reshaping the codebase.
 * No implementation should call these in read-only mode. */

export interface BitbucketWriteClient {
  /** TODO(phase 2): post a general PR comment. */
  addPullRequestComment(params: BitbucketRepoTarget & {
    prId: number;
    text: string;
  }): Promise<void>;

  /** TODO(phase 2): approve / request changes. */
  setReviewStatus(params: BitbucketRepoTarget & {
    prId: number;
    status: 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED';
  }): Promise<void>;
}
