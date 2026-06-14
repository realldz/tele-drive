'use client';

import { useEffect, useState, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import axios from 'axios';

// Configure PDF.js worker — unpkg serves directly from npm, guaranteed to have this version
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export function PreviewPdf({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(true);

  // Fetch PDF binary data with credentials, then create a Blob URL.
  // Using a Blob URL avoids pdfjs-dist detaching ArrayBuffers on re-render.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setIsFetching(true); // eslint-disable-line react-hooks/set-state-in-effect
    setFetchError(null);

    axios
      .get(url, { responseType: 'blob', withCredentials: true })
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setBlobUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          const status = err?.response?.status;
          setFetchError(
            status === 401 || status === 403
              ? 'Authentication expired. Please refresh the page.'
              : `Failed to load PDF (${status || 'network error'})`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsFetching(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.min(entry.contentRect.width - 32, 1200));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  if (isFetching) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (fetchError || !blobUrl) {
    return (
      <div className="text-center py-20 text-red-500">{fetchError || 'Failed to load PDF'}</div>
    );
  }

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
          file={blobUrl}
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
