/**
 * Build a git clone URL for a Bitbucket repository.
 *
 * SECURITY: the token is NEVER part of the URL. At most the username is embedded
 * (`https://<username>@host/...`) so Git Credential Manager can prompt for / pick
 * up the password/token itself. This function does not accept a token argument at
 * all, so it is structurally impossible for it to leak one.
 */
export interface CloneUrlOptions {
  /** "cloud" (bitbucket.org) or "datacenter" (self-hosted). Defaults to cloud. */
  type?: 'cloud' | 'datacenter';
  repoSlug: string;
  /** Cloud workspace (e.g. "nls-kz"). */
  workspace?: string;
  /** Data Center project key (used only when type === "datacenter"). */
  projectKey?: string;
  /** Data Center base URL (used only when type === "datacenter"). */
  baseUrl?: string;
  /** Bitbucket username; embedded only when present and useUsername !== false. */
  username?: string;
  /** Pass false to omit the username even when one is configured. */
  useUsername?: boolean;
}

export function buildCloneUrl(opts: CloneUrlOptions): string {
  const slug = (opts.repoSlug || '').trim();
  const user = (opts.username || '').trim();
  const withUser = opts.useUsername !== false && user.length > 0;
  const auth = withUser ? `${encodeURIComponent(user)}@` : '';

  if (opts.type === 'datacenter' && opts.baseUrl) {
    let host = opts.baseUrl.trim().replace(/\/+$/, '');
    let protocol = 'https';
    const m = /^(https?):\/\/(.+)$/i.exec(host);
    if (m) {
      protocol = m[1].toLowerCase();
      host = m[2];
    }
    const project = (opts.projectKey || '').trim();
    return `${protocol}://${auth}${host}/scm/${project}/${slug}.git`;
  }

  const workspace = (opts.workspace || '').trim();
  return `https://${auth}bitbucket.org/${workspace}/${slug}.git`;
}

/** Argv for `git clone` — always an array so there is no shell-injection surface. */
export function buildCloneArgs(url: string, destination: string): string[] {
  return ['clone', url, destination];
}
