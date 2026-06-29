import axios, { AxiosInstance } from 'axios';
import { JiraConfig, JiraFieldsFile } from '../config/types';
import { logger } from '../utils/logger';

export interface JiraClientConfig extends JiraConfig {}

export interface NormalizedJiraComment {
  author: string;
  created?: string;
  body: string;
}

export interface NormalizedJiraLink {
  type: string;
  direction: 'inward' | 'outward';
  key: string;
  summary?: string;
  status?: string;
}

export interface NormalizedJiraAttachment {
  filename: string;
  size?: number;
  mimeType?: string;
  created?: string;
  author?: string;
}

export interface NormalizedJira {
  key: string;
  summary: string;
  status: string;
  issuetype?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  descriptionText: string;
  comments: NormalizedJiraComment[];
  links: NormalizedJiraLink[];
  attachments: NormalizedJiraAttachment[];
  customFields: Array<{ id: string; label: string; value: string }>;
  url?: string;
}

/**
 * Best-effort plain-text extraction from an Atlassian Document Format (ADF)
 * node, a plain string, or rendered HTML.
 */
export function extractAdfText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractAdfText).join('');

  const n = node as Record<string, any>;

  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (n.type === 'hardBreak') return '\n';

  let text = '';
  if (Array.isArray(n.content)) {
    text = n.content.map(extractAdfText).join('');
  }

  switch (n.type) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
      return text + '\n';
    case 'listItem':
      return `- ${text}\n`;
    case 'bulletList':
    case 'orderedList':
      return text;
    case 'mediaSingle':
    case 'mediaGroup':
      return text;
    default:
      return text;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export class JiraClient {
  private http: AxiosInstance;

  constructor(private cfg: JiraClientConfig) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.email && cfg.apiToken) {
      // Jira Cloud: Basic auth with email:apiToken.
      const basic = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else if (cfg.apiToken) {
      // Jira Data Center: Personal Access Token as Bearer.
      headers.Authorization = `Bearer ${cfg.apiToken}`;
    }

    this.http = axios.create({
      baseURL: cfg.baseUrl.replace(/\/+$/, ''),
      headers,
      timeout: 30000,
    });
  }

  private api(suffix: string): string {
    return `/rest/api/${this.cfg.apiVersion}${suffix}`;
  }

  /** Fetch an issue with the configured fields and the changelog expanded. */
  async getIssue(issueKey: string, fields: JiraFieldsFile): Promise<any> {
    const fieldList = [
      ...fields.standardFields,
      ...fields.customFields.map((f) => f.id),
    ];
    const res = await this.http.get(this.api(`/issue/${encodeURIComponent(issueKey)}`), {
      params: {
        fields: fieldList.join(','),
        expand: 'changelog,renderedFields',
      },
    });
    return res.data;
  }

  /** Fetch the full changelog (paginated). Returns [] if unavailable. */
  async getIssueChangelog(issueKey: string): Promise<any[]> {
    const histories: any[] = [];
    let startAt = 0;
    const maxResults = 100;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await this.http.get(
          this.api(`/issue/${encodeURIComponent(issueKey)}/changelog`),
          { params: { startAt, maxResults } },
        );
        const values = res.data?.values ?? [];
        histories.push(...values);
        if (res.data?.isLast || values.length < maxResults || histories.length >= (res.data?.total ?? 0)) {
          break;
        }
        startAt += maxResults;
      }
    } catch {
      // Dedicated changelog endpoint not available (e.g. older DC); fall back to
      // the expanded changelog from getIssue.
      logger.debug(`Changelog endpoint unavailable for ${issueKey}; relying on expanded changelog.`);
    }
    return histories;
  }

  async searchIssuesByJql(jql: string, maxResults = 50): Promise<any[]> {
    const res = await this.http.get(this.api('/search'), {
      params: { jql, maxResults },
    });
    return res.data?.issues ?? [];
  }
}

/** Reduce a raw Jira issue payload to the fields we care about for review. */
export function normalizeIssue(
  raw: any,
  baseUrl: string,
  customFieldDefs: JiraFieldsFile['customFields'],
): NormalizedJira {
  const f = raw?.fields ?? {};

  const descriptionText = extractDescription(raw);

  const comments: NormalizedJiraComment[] = (f.comment?.comments ?? []).map((c: any) => ({
    author: c.author?.displayName ?? c.author?.name ?? 'unknown',
    created: c.created,
    body: extractAdfText(c.body) || (typeof c.body === 'string' ? c.body : ''),
  }));

  const links: NormalizedJiraLink[] = (f.issuelinks ?? []).map((l: any) => {
    const outward = l.outwardIssue;
    const inward = l.inwardIssue;
    const linked = outward ?? inward ?? {};
    return {
      type: l.type?.name ?? 'relates',
      direction: outward ? 'outward' : 'inward',
      key: linked.key ?? '',
      summary: linked.fields?.summary,
      status: linked.fields?.status?.name,
    };
  });

  const attachments: NormalizedJiraAttachment[] = (f.attachment ?? []).map((a: any) => ({
    filename: a.filename,
    size: a.size,
    mimeType: a.mimeType,
    created: a.created,
    author: a.author?.displayName ?? a.author?.name,
  }));

  const customFields = customFieldDefs.map((def) => ({
    id: def.id,
    label: def.label,
    value: extractAdfText(f[def.id]) || stringifyValue(f[def.id]),
  }));

  return {
    key: raw?.key ?? '',
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    issuetype: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName ?? f.assignee?.name,
    reporter: f.reporter?.displayName ?? f.reporter?.name,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c: any) => c.name),
    fixVersions: (f.fixVersions ?? []).map((v: any) => v.name),
    descriptionText,
    comments,
    links,
    attachments,
    customFields,
    url: raw?.key ? `${baseUrl.replace(/\/+$/, '')}/browse/${raw.key}` : undefined,
  };
}

function extractDescription(raw: any): string {
  const f = raw?.fields ?? {};
  const desc = f.description;
  if (typeof desc === 'string' && desc.trim()) return desc.trim();
  if (desc && typeof desc === 'object') {
    const text = extractAdfText(desc).trim();
    if (text) return text;
  }
  // Fallback to rendered HTML if present.
  const rendered = raw?.renderedFields?.description;
  if (typeof rendered === 'string' && rendered.trim()) return stripHtml(rendered);
  return '';
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const v = value as Record<string, any>;
    if (typeof v.value === 'string') return v.value;
    if (typeof v.name === 'string') return v.name;
  }
  return '';
}
