'use client';

import { useEffect, useState, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import php from 'highlight.js/lib/languages/php';
import 'highlight.js/styles/github.css';
import axios from 'axios';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('php', php);

const LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyw: 'python',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml',
  css: 'css', scss: 'css', less: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql',
  md: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  java: 'java',
  go: 'go',
  rs: 'rust',
  cs: 'csharp',
  c: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  php: 'php',
};

export default function PreviewCodeViewer({ url, filename }: { url: string; filename: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const codeRef = useRef<HTMLElement>(null);
  const highlightedRef = useRef(false);

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const lang = LANG_MAP[ext] || '';

  useEffect(() => {
    setIsLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    highlightedRef.current = false;
    axios.get(url, { responseType: 'text', withCredentials: true, transformResponse: [(data: unknown) => data] })
      .then(res => setContent(res.data))
      .catch(() => setContent('Failed to load file content'))
      .finally(() => setIsLoading(false));
  }, [url]);

  useEffect(() => {
    if (content && codeRef.current && !highlightedRef.current) {
      highlightedRef.current = true;
      hljs.highlightElement(codeRef.current);
    }
  }, [content]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-white">
      <pre className="p-4 m-0 text-sm leading-relaxed" style={{ tabSize: 2 }}>
        <code ref={codeRef} className={lang ? `language-${lang}` : ''}>
          {content}
        </code>
      </pre>
    </div>
  );
}
