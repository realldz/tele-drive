'use client';

import { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { Download, Loader2, FileIcon, Music } from 'lucide-react';
import 'plyr/dist/plyr.css';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
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

// Register highlight.js languages
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

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// --- Sub-components ---

function PlyrVideo({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    let destroyed = false;
    import('plyr').then(({ default: Plyr }) => {
      if (destroyed || !videoRef.current) return;
      playerRef.current = new Plyr(videoRef.current, {
        controls: ['play-large', 'play', 'progress', 'current-time', 'duration',
          'mute', 'volume', 'settings', 'pip', 'fullscreen'],
        settings: ['speed'],
      });
    });
    return () => { destroyed = true; playerRef.current?.destroy(); };
  }, []);

  return (
    <div className="flex h-full items-center justify-center bg-black plyr-container">
      <video ref={videoRef} src={src} crossOrigin="use-credentials" playsInline />
    </div>
  );
}

function PlyrAudio({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    if (!audioRef.current) return;
    let destroyed = false;
    import('plyr').then(({ default: Plyr }) => {
      if (destroyed || !audioRef.current) return;
      playerRef.current = new Plyr(audioRef.current, {
        controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings'],
        settings: ['speed'],
      });
    });
    return () => { destroyed = true; playerRef.current?.destroy(); };
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center p-4 bg-gray-100">
      <Music className="mb-8 h-32 w-32 text-gray-400" />
      <div className="w-full max-w-xl">
        <audio ref={audioRef} src={src} crossOrigin="use-credentials" />
      </div>
    </div>
  );
}

function PdfViewer({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.min(entry.contentRect.width - 32, 1200));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="h-full w-full flex flex-col">
      {numPages > 0 && (
        <div className="flex items-center justify-center gap-4 py-2 bg-gray-100 border-b border-gray-200 flex-none">
          <button
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber(p => p - 1)}
            className="px-3 py-1 text-sm font-medium rounded-md bg-white border border-gray-300 disabled:opacity-40 hover:bg-gray-50 transition-colors"
          >
            &larr; Prev
          </button>
          <span className="text-sm text-gray-600 font-medium">
            {pageNumber} / {numPages}
          </span>
          <button
            disabled={pageNumber >= numPages}
            onClick={() => setPageNumber(p => p + 1)}
            className="px-3 py-1 text-sm font-medium rounded-md bg-white border border-gray-300 disabled:opacity-40 hover:bg-gray-50 transition-colors"
          >
            Next &rarr;
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto flex justify-center p-4 bg-gray-200">
        <Document
          file={url}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          loading={
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          }
          error={
            <div className="text-center py-20 text-red-500">Failed to load PDF</div>
          }
        >
          <Page
            pageNumber={pageNumber}
            width={width}
            loading={
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            }
          />
        </Document>
      </div>
    </div>
  );
}

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

function CodeViewer({ url, filename }: { url: string; filename: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const codeRef = useRef<HTMLElement>(null);
  const highlightedRef = useRef(false);

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const lang = LANG_MAP[ext] || '';

  useEffect(() => {
    setIsLoading(true);
    highlightedRef.current = false;
    axios.get(url, { responseType: 'text', transformResponse: [(data: any) => data] })
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

// --- Main Component ---

interface PreviewRendererProps {
  streamUrl: string;
  downloadUrl: string;
  fileInfo: { filename: string; mimeType: string; size: number };
  t: (key: string, params?: any) => string;
}

export default function PreviewRenderer({ streamUrl, downloadUrl, fileInfo, t }: PreviewRendererProps) {
  const { mimeType, filename } = fileInfo;

  // Image
  if (mimeType.startsWith('image/')) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img
          src={streamUrl}
          alt={filename}
          className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
        />
      </div>
    );
  }

  // Video
  if (mimeType.startsWith('video/')) {
    return <PlyrVideo src={streamUrl} />;
  }

  // Audio
  if (mimeType.startsWith('audio/')) {
    return <PlyrAudio src={streamUrl} />;
  }

  // PDF
  if (mimeType === 'application/pdf') {
    return <PdfViewer url={streamUrl} />;
  }

  // Text / Code
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return <CodeViewer url={streamUrl} filename={filename} />;
  }

  // Fallback
  return (
    <div className="flex h-full flex-col items-center justify-center bg-gray-50">
      <FileIcon className="mb-4 h-24 w-24 text-gray-400" />
      <h3 className="mb-2 text-xl font-medium text-gray-800">{t('preview.notAvailable')}</h3>
      <p className="mb-6 text-gray-500">{t('preview.cannotPreview', { mimeType })}</p>
      <a
        href={downloadUrl}
        download={filename}
        className="flex items-center gap-2 rounded bg-blue-500 px-6 py-3 font-semibold text-white shadow hover:bg-blue-600 transition-colors"
      >
        <Download className="h-5 w-5" />
        {t('preview.downloadFile')}
      </a>
    </div>
  );
}
