import { AppConfig } from '../../config/types';
import { JQL_QUERIES_FILE } from './jql-queries';

/**
 * Non-secret view of the loaded configuration for the Settings page.
 *
 * SECURITY: token/password values are NEVER included — only booleans telling
 * whether a credential is present. Base URLs, emails, workspace and Claude
 * run settings are not secrets and are shown to help debugging.
 */
export interface ConfigStatus {
  jira: {
    baseUrl: string;
    email: string;
    apiVersion: string;
    hasApiToken: boolean;
  };
  bitbucket: {
    type: string;
    workspace: string;
    baseUrl: string;
    hasUsername: boolean;
    hasToken: boolean;
  };
  claude: {
    bin: string;
    model: string;
    effort: string;
    permissionMode: string;
    outputFormat: string;
    maxTurns: number | null;
  };
  paths: {
    reposDir: string;
    worktreesDir: string;
    outputsDir: string;
    locksDir: string;
  };
  /** Jira JQL Queue: where saved queries live + whether search can run. */
  jql: {
    file: string;
    jiraConfigured: boolean;
  };
  /** "set" / "missing" per important env var — never the value itself. */
  env: Record<string, 'set' | 'missing'>;
  repoCount: number;
  /** Always true for the MVP: the GUI performs no write actions. */
  readOnly: boolean;
}

const present = (v: string | undefined | null): 'set' | 'missing' =>
  v && String(v).trim() ? 'set' : 'missing';

export function getConfigStatus(config: AppConfig): ConfigStatus {
  return {
    jira: {
      baseUrl: config.jira.baseUrl,
      email: config.jira.email,
      apiVersion: config.jira.apiVersion,
      hasApiToken: Boolean(config.jira.apiToken),
    },
    bitbucket: {
      type: config.bitbucket.type,
      workspace: config.bitbucket.workspace,
      baseUrl: config.bitbucket.baseUrl,
      hasUsername: Boolean(config.bitbucket.username),
      hasToken: Boolean(config.bitbucket.token),
    },
    claude: {
      bin: config.claude.bin,
      model: config.claude.model,
      effort: config.claude.effort,
      permissionMode: config.claude.permissionMode,
      outputFormat: config.claude.outputFormat,
      maxTurns: config.claude.maxTurns ?? null,
    },
    paths: {
      reposDir: config.root.reposDir,
      worktreesDir: config.root.worktreesDir,
      outputsDir: config.root.outputsDir,
      locksDir: config.root.locksDir,
    },
    jql: {
      file: JQL_QUERIES_FILE,
      jiraConfigured: Boolean(config.jira.baseUrl && config.jira.apiToken),
    },
    env: {
      JIRA_BASE_URL: present(process.env.JIRA_BASE_URL),
      JIRA_API_TOKEN: present(process.env.JIRA_API_TOKEN),
      BITBUCKET_USERNAME: present(process.env.BITBUCKET_USERNAME),
      BITBUCKET_TOKEN: present(process.env.BITBUCKET_TOKEN),
    },
    repoCount: Object.keys(config.repos).length,
    readOnly: true,
  };
}
