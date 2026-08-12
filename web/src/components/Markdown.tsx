import ReactMarkdown from 'react-markdown';

/**
 * Safe markdown renderer. react-markdown does not use dangerouslySetInnerHTML
 * and ignores raw HTML by default, so review/followup output (which can echo
 * arbitrary code snippets) cannot inject scripts.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
