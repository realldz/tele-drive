'use client';

import { useState, useEffect, useRef } from 'react';
import axios, { CancelTokenSource } from 'axios';
import { UploadCloud, X, Loader2 } from 'lucide-react';

const API_URL = 'http://localhost:3001';
const CONCURRENCY = 3;

interface UploadState {
  status: 'idle' | 'uploading' | 'cancelling' | 'error';
  filename: string;
  totalSize: number;
  uploadedBytes: number;
  completedChunks: number;
  totalChunks: number;
  errorMessage?: string;
}

export default function UploadZone({ folderId, onUploadSuccess }: { folderId?: string, onUploadSuccess: () => void }) {
  const [maxChunkSize, setMaxChunkSize] = useState<number>(19 * 1024 * 1024);
  const [uploadState, setUploadState] = useState<UploadState>({
    status: 'idle',
    filename: '',
    totalSize: 0,
    uploadedBytes: 0,
    completedChunks: 0,
    totalChunks: 0,
  });

  // Refs cho abort
  const abortRef = useRef(false);
  const activeFileIdRef = useRef<string | null>(null);
  const abortControllersRef = useRef<AbortController[]>([]);
  const simpleAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    axios.get(`${API_URL}/files/config`)
      .then(res => setMaxChunkSize(res.data.maxChunkSize))
      .catch(() => { });
  }, []);

  const resetState = () => {
    abortRef.current = false;
    activeFileIdRef.current = null;
    abortControllersRef.current = [];
    simpleAbortControllerRef.current = null;
    setUploadState({
      status: 'idle',
      filename: '',
      totalSize: 0,
      uploadedBytes: 0,
      completedChunks: 0,
      totalChunks: 0,
    });
  };

  /**
   * Huỷ upload:
   *   1. Huỷ tất cả HTTP requests đang in-flight (AbortController.abort())
   *   2. Gọi API /abort để server xoá chunks đã upload trên Telegram
   *   3. Reset UI
   */
  const handleAbort = async () => {
    if (abortRef.current) return;
    abortRef.current = true;

    setUploadState(prev => ({ ...prev, status: 'cancelling' }));

    // 1) Huỷ tất cả HTTP requests đang bay
    abortControllersRef.current.forEach(ctrl => ctrl.abort());
    if (simpleAbortControllerRef.current) {
      simpleAbortControllerRef.current.abort();
    }

    // 2) Gọi API abort trên server (nếu là chunked upload)
    const fileId = activeFileIdRef.current;
    if (fileId) {
      try {
        const result = await axios.post(`${API_URL}/files/upload/${fileId}/abort`);
        console.log(`Upload aborted: ${result.data.deletedChunks} chunks deleted from Telegram`);
      } catch (err) {
        console.warn('Abort API call failed (file may already be cleaned up):', err);
      }
    }

    // 3) Reset UI (nhưng KHÔNG reset abortRef — để handleFileChange catch detecttải)
    activeFileIdRef.current = null;
    abortControllersRef.current = [];
    simpleAbortControllerRef.current = null;
    setUploadState({
      status: 'idle',
      filename: '',
      totalSize: 0,
      uploadedBytes: 0,
      completedChunks: 0,
      totalChunks: 0,
    });
  };

  /**
   * Upload file nhỏ — flow đơn giản (1 request, có abort)
   */
  const uploadSimple = async (file: File) => {
    setUploadState({
      status: 'uploading',
      filename: file.name,
      totalSize: file.size,
      uploadedBytes: 0,
      completedChunks: 0,
      totalChunks: 1,
    });

    const abortController = new AbortController();
    simpleAbortControllerRef.current = abortController;

    const formData = new FormData();
    formData.append('file', file);
    if (folderId) formData.append('folderId', folderId);

    await axios.post(`${API_URL}/files/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      signal: abortController.signal,
      onUploadProgress: (progressEvent) => {
        setUploadState(prev => ({
          ...prev,
          uploadedBytes: progressEvent.loaded || 0,
        }));
      },
    });
  };

  /**
   * Upload file lớn — chia chunks, upload song song, có thể abort bất kỳ lúc nào
   */
  const uploadChunked = async (file: File) => {
    const totalChunks = Math.ceil(file.size / maxChunkSize);

    setUploadState({
      status: 'uploading',
      filename: file.name,
      totalSize: file.size,
      uploadedBytes: 0,
      completedChunks: 0,
      totalChunks,
    });

    // 1) Khởi tạo upload session
    const initRes = await axios.post(`${API_URL}/files/upload/init`, {
      filename: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      folderId: folderId || undefined,
    });

    const fileId = initRes.data.id;
    activeFileIdRef.current = fileId;

    // Track progress
    const chunkProgress: number[] = new Array(totalChunks).fill(0);
    const chunkSizes: number[] = [];
    let completedCount = 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * maxChunkSize;
      const end = Math.min(start + maxChunkSize, file.size);
      chunkSizes.push(end - start);
    }

    const queue = Array.from({ length: totalChunks }, (_, i) => i);

    const updateProgress = () => {
      const totalUploaded = chunkProgress.reduce((a, b) => a + b, 0);
      setUploadState(prev => ({
        ...prev,
        uploadedBytes: Math.min(totalUploaded, file.size),
        completedChunks: completedCount,
      }));
    };

    // Upload 1 chunk với AbortController riêng
    const uploadSingleChunk = async (chunkIndex: number) => {
      const start = chunkIndex * maxChunkSize;
      const end = Math.min(start + maxChunkSize, file.size);
      const chunkBlob = file.slice(start, end);

      const chunkFormData = new FormData();
      chunkFormData.append('chunk', chunkBlob, `chunk_${chunkIndex}`);

      // Tạo AbortController riêng cho chunk này
      const abortController = new AbortController();
      abortControllersRef.current.push(abortController);

      await axios.post(
        `${API_URL}/files/upload/${fileId}/chunk/${chunkIndex}`,
        chunkFormData,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          signal: abortController.signal,
          onUploadProgress: (progressEvent) => {
            chunkProgress[chunkIndex] = progressEvent.loaded || 0;
            updateProgress();
          },
        },
      );

      chunkProgress[chunkIndex] = chunkSizes[chunkIndex];
      completedCount++;
      updateProgress();
    };

    // Workers: mỗi worker lấy chunk từ queue
    const worker = async () => {
      while (queue.length > 0) {
        if (abortRef.current) return;
        const chunkIndex = queue.shift();
        if (chunkIndex === undefined) return;
        await uploadSingleChunk(chunkIndex);
      }
    };

    const workers = Array(Math.min(CONCURRENCY, totalChunks))
      .fill(null)
      .map(() => worker());

    await Promise.all(workers);

    if (abortRef.current) {
      throw new Error('Upload đã bị huỷ');
    }

    await axios.post(`${API_URL}/files/upload/${fileId}/complete`);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      if (file.size <= maxChunkSize) {
        await uploadSimple(file);
      } else {
        await uploadChunked(file);
      }
      onUploadSuccess();
      resetState();
    } catch (error: any) {
      // Nếu là abort (CanceledError hoặc user huỷ), không hiện lỗi
      if (axios.isCancel(error) || abortRef.current) {
        // Cleanup đã được handleAbort xử lý, chỉ cần reset abort flag
        abortRef.current = false;
        return;
      }
      console.error('Upload failed:', error);
      setUploadState(prev => ({
        ...prev,
        status: 'error',
        errorMessage: error?.response?.data?.message || error?.message || 'Tải lên thất bại',
      }));
    } finally {
      e.target.value = '';
    }
  };

  let overallPercent = uploadState.totalSize > 0
    ? Math.round((uploadState.uploadedBytes / uploadState.totalSize) * 100)
    : 0;

  let isServerProcessing = false;
  if (overallPercent === 100 && uploadState.status === 'uploading') {
    overallPercent = 99;
    isServerProcessing = true;
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  return (
    <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors relative">
      {uploadState.status === 'idle' && (
        <>
          <input
            type="file"
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="flex flex-col items-center justify-center space-y-2 pointer-events-none">
            <UploadCloud className="w-10 h-10 text-gray-400" />
            <p className="text-sm font-medium text-gray-700">Kéo thả file vào đây hoặc nhấn để chọn</p>
            <p className="text-xs text-gray-500">
              Hỗ trợ mọi định dạng. File tải lên sẽ được mã hoá và lưu trữ an toàn.
            </p>
          </div>
        </>
      )}

      {uploadState.status === 'uploading' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="w-5 h-5 text-blue-600 animate-pulse flex-shrink-0" />
              <span className="text-sm font-medium text-gray-800 truncate">{uploadState.filename}</span>
            </div>
            <button
              onClick={handleAbort}
              className="flex items-center gap-1 px-2 py-1 text-sm text-red-500 bg-red-50 rounded hover:bg-red-100 transition-colors flex-shrink-0 cursor-pointer"
              title="Huỷ upload"
            >
              <X size={14} />
              Huỷ
            </button>
          </div>

          <div className="w-full bg-gray-200 rounded-full h-2.5">
            <div
              className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${overallPercent}%` }}
            />
          </div>

          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>
              {isServerProcessing
                ? 'Đang xử lí trên máy chủ, vui lòng đợi phút chốc...'
                : uploadState.totalChunks > 1
                  ? `Chunk ${uploadState.completedChunks}/${uploadState.totalChunks} (${CONCURRENCY} song song)`
                  : 'Đang tải lên...'
              }
            </span>
            <span>{formatSize(uploadState.uploadedBytes)} / {formatSize(uploadState.totalSize)} ({overallPercent}%)</span>
          </div>
        </div>
      )}

      {uploadState.status === 'cancelling' && (
        <div className="flex flex-col items-center justify-center space-y-2 py-2">
          <Loader2 className="w-6 h-6 text-orange-500 animate-spin" />
          <p className="text-sm font-medium text-orange-600">Đang huỷ upload và dọn dẹp dữ liệu trên Telegram...</p>
        </div>
      )}

      {uploadState.status === 'error' && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-red-600">❌ {uploadState.errorMessage}</p>
          <button
            onClick={resetState}
            className="text-sm text-blue-600 hover:underline cursor-pointer"
          >
            Thử lại
          </button>
        </div>
      )}
    </div>
  );
}
