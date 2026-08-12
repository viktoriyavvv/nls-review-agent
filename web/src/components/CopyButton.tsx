import { useState } from 'react';

interface Props {
  text: string | null | undefined;
  label?: string;
  className?: string;
}

/** Copy-to-clipboard button with a brief "Copied" confirmation. */
export function CopyButton({ text, label = 'Copy', className = 'btn sm' }: Props) {
  const [done, setDone] = useState(false);
  const disabled = !text;

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  }

  return (
    <button className={className} onClick={copy} disabled={disabled} title={label}>
      {done ? '✓ Copied' : label}
    </button>
  );
}
