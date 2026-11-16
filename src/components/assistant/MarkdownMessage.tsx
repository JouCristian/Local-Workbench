import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="assistant-code">
      <button
        type="button"
        className="icon-button"
        aria-label={copied ? '已复制代码' : '复制代码'}
        onClick={async (e) => {
          const text = e.currentTarget.parentElement?.querySelector('pre')?.textContent ?? '';
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** Raw HTML is never executed; remote images are links, avoiding automatic tracking. */
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        img: ({ alt }) => (
          <span className="assistant-image-reference">[图片：{alt || '附件'}]</span>
        ),
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => (
          <div className="assistant-markdown-table">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
