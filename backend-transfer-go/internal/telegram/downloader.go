package telegram

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/redis/go-redis/v9"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/settings"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
)

type DownloadInfo struct {
	ID                string
	Filename          string
	Size              int64
	MimeType          string
	IsBuffered        bool
	TempStorageKey    string
	IsChunked         bool
	TelegramFileID    string
	BotID             int64
	TelegramMessageID *int
	IsEncrypted       bool
	DEK               []byte
	IV                []byte
	Chunks            []ChunkInfo
}

type ChunkInfo struct {
	ID                string
	TelegramFileID    string
	BotID             int64
	TelegramMessageID *int
	IV                []byte
	Size              int64
	IsBuffered        bool
	TempStorageKey    string
}

type Downloader struct {
	telegramClient *TelegramClient
	cryptoEngine   *crypto.CryptoEngine
	tempStorage    *storage.TempStorage
	RedisClient    *redis.Client
	httpClient     *http.Client
	logger         *slog.Logger
	bandwidthEnabled bool
	batchReporter    BandwidthReporter
	quotaResolver    *QuotaResolver
	settingsResolver *settings.Resolver
}

func NewDownloader(
	telegramClient *TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	redisClient *redis.Client,
	logger *slog.Logger,
	bandwidthEnabled bool,
	batchReporter BandwidthReporter,
	quotaResolver *QuotaResolver,
	settingsResolver *settings.Resolver,
) *Downloader {
	return &Downloader{
		telegramClient:   telegramClient,
		cryptoEngine:     cryptoEngine,
		tempStorage:      tempStorage,
		RedisClient:      redisClient,
		logger:           logger,
		bandwidthEnabled: bandwidthEnabled,
		batchReporter:    batchReporter,
		quotaResolver:    quotaResolver,
		settingsResolver: settingsResolver,
		httpClient: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}
}

// multiThreadEnabled resolves the admin-dashboard ENABLE_MULTI_THREAD_DOWNLOAD
// setting (default true). When no resolver is wired, multi-thread stays enabled
// to preserve the prior default behavior.
func (d *Downloader) multiThreadEnabled(ctx context.Context) bool {
	if d.settingsResolver == nil {
		return true
	}
	return d.settingsResolver.GetBool(ctx, "ENABLE_MULTI_THREAD_DOWNLOAD", true)
}

func (d *Downloader) GetDownloadInfo(meta *pb.FileMetadata) (*DownloadInfo, error) {
	var dek []byte
	var err error
	if meta.IsEncrypted && meta.EncryptedKey != "" {
		dek, err = d.cryptoEngine.DecryptKey(meta.EncryptedKey)
		if err != nil {
			return nil, err
		}
	}

	var iv []byte
	if meta.EncryptionIv != "" {
		iv, _ = hex.DecodeString(meta.EncryptionIv)
	}

	// A buffered SINGLE file is one blob on disk → serve it directly. A buffered
	// CHUNKED file has no single blob; its parts live at chunk/{id}/{idx}.tmp and
	// each is served individually by the chunked branch below (buffered chunk →
	// temp disk, completed chunk → Telegram). Gating on !IsChunked is essential:
	// treating a draining chunked file as a single buffered blob would advertise
	// Content-Length=size but stream from a temp key that does not exist →
	// ERR_CONTENT_LENGTH_MISMATCH.
	if meta.Status == "buffered" && !meta.IsChunked {
		// NestJS stores buffered single files at a random-UUID key; prefer the
		// real key carried in metadata, fall back to the legacy convention.
		tempKey := meta.TempStorageKey
		if tempKey == "" {
			tempKey = fmt.Sprintf("buf/%s.tmp", meta.Id)
		}
		return &DownloadInfo{
			ID:             meta.Id,
			Filename:       meta.Filename,
			Size:           meta.Size,
			MimeType:       meta.MimeType,
			IsBuffered:     true,
			TempStorageKey: tempKey,
			IsChunked:      false,
		}, nil
	}

	if !meta.IsChunked && meta.TelegramFileId != "" {
		var msgID *int
		if meta.TelegramMessageId != 0 {
			val := int(meta.TelegramMessageId)
			msgID = &val
		}

		return &DownloadInfo{
			ID:                meta.Id,
			Filename:          meta.Filename,
			Size:              meta.Size,
			MimeType:          meta.MimeType,
			IsBuffered:        false,
			IsChunked:         false,
			TelegramFileID:    meta.TelegramFileId,
			BotID:             meta.BotId,
			TelegramMessageID: msgID,
			IsEncrypted:       meta.IsEncrypted,
			DEK:               dek,
			IV:                iv,
		}, nil
	}

	chunks := make([]ChunkInfo, len(meta.Chunks))
	for i, c := range meta.Chunks {
		var chunkIv []byte
		if c.EncryptionIv != "" {
			chunkIv, _ = hex.DecodeString(c.EncryptionIv)
		}

		isBuffered := c.TelegramFileId == ""
		var tempKey string
		if isBuffered {
			tempKey = fmt.Sprintf("chunk/%s/%d.tmp", meta.Id, c.ChunkIndex)
		}

		var msgID *int
		if c.TelegramMessageId != 0 {
			val := int(c.TelegramMessageId)
			msgID = &val
		}

		chunks[i] = ChunkInfo{
			ID:                fmt.Sprintf("%s-chunk-%d", meta.Id, c.ChunkIndex),
			TelegramFileID:    c.TelegramFileId,
			BotID:             c.BotId,
			TelegramMessageID: msgID,
			IV:                chunkIv,
			Size:              int64(c.Size),
			IsBuffered:        isBuffered,
			TempStorageKey:    tempKey,
		}
	}

	return &DownloadInfo{
		ID:          meta.Id,
		Filename:    meta.Filename,
		Size:        meta.Size,
		MimeType:    meta.MimeType,
		IsBuffered:  false,
		IsChunked:   true,
		Chunks:      chunks,
		IsEncrypted: meta.IsEncrypted,
		DEK:         dek,
	}, nil
}

func (d *Downloader) ServeDownload(c echo.Context, info *DownloadInfo, rangeHeader string, disposition string) error {
	fileSize := info.Size
	start := int64(0)
	end := fileSize - 1

	// Multi-thread (Range) support is admin-gated (ENABLE_MULTI_THREAD_DOWNLOAD).
	// When disabled, the Range header is ignored — the full file is served and
	// Accept-Ranges is not advertised — so download managers fall back to a
	// single connection. Mirrors NestJS isMultiThreadEnabled().
	multiThread := d.multiThreadEnabled(c.Request().Context())

	hasRangeHeader := rangeHeader != "" && multiThread
	isRange := false
	if hasRangeHeader {
		parts := strings.Split(rangeHeader, "=")
		if len(parts) == 2 && parts[0] == "bytes" {
			rangeParts := strings.Split(parts[1], "-")
			if len(rangeParts) == 2 {
				if rangeParts[0] == "" {
					if suffix, err := strconv.ParseInt(rangeParts[1], 10, 64); err == nil && suffix > 0 {
						start = fileSize - suffix
						if start < 0 {
							start = 0
						}
						isRange = true
					}
				} else if s, err := strconv.ParseInt(rangeParts[0], 10, 64); err == nil {
					start = s
					isRange = true
					if rangeParts[1] != "" {
						if e, err := strconv.ParseInt(rangeParts[1], 10, 64); err == nil {
							end = e
						}
					}
				}
			}
		}
	}

	if start >= fileSize {
		c.Response().Header().Set("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
		return c.NoContent(http.StatusRequestedRangeNotSatisfiable)
	}

	if end >= fileSize {
		end = fileSize - 1
	}

	contentLength := end - start + 1

	// Lock & Check Bandwidth (stubbed out DB updates)
	lock, err := d.CheckAndLockBandwidth(c, info.ID, fileSize, contentLength, hasRangeHeader)
	if err != nil {
		return err
	}

	initialSize := c.Response().Size
	defer func() {
		actualBytes := c.Response().Size - initialSize
		d.RefundAndReconcile(lock, actualBytes)
	}()

	res := c.Response()

	if multiThread {
		res.Header().Set("Accept-Ranges", "bytes")
	}
	res.Header().Set("Content-Length", strconv.FormatInt(contentLength, 10))
	res.Header().Set("Content-Type", info.MimeType)

	if disposition == "attachment" {
		quoted := strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(info.Filename)
		res.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, quoted, url.PathEscape(info.Filename)))
	} else {
		res.Header().Set("Content-Disposition", "inline")
	}

	if isRange {
		res.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
		res.WriteHeader(http.StatusPartialContent)
	} else {
		res.WriteHeader(http.StatusOK)
	}

	res.Flush()

	ctx := c.Request().Context()

	// Stream through `res` (*echo.Response), NOT res.Writer (the raw
	// http.ResponseWriter). Only *echo.Response.Write increments res.Size; writing
	// to the bare Writer bypasses the counter, so the deferred
	// actualBytes = Size - initialSize reads 0 — which then refunds the whole
	// estimatedSize and reports bytes=0, the root cause of "bandwidth never moves".
	if info.IsBuffered {
		reader, err := d.tempStorage.ReadRange(info.TempStorageKey, start, contentLength)
		if err != nil {
			return err
		}
		defer reader.Close()
		_, err = io.Copy(res, reader)
		return err
	}

	if !info.IsChunked {
		return d.streamSingle(ctx, res, info, start, end)
	}
	return d.streamChunked(ctx, res, info, start, end)
}

func (d *Downloader) resolveFileLink(ctx context.Context, fileID string, botID int64, msgID *int, chunkDbID *string) (string, error) {
	link, err := d.telegramClient.GetFileLink(ctx, fileID, botID)
	if err == nil {
		return link, nil
	}

	if msgID == nil {
		return "", fmt.Errorf("bot %d unavailable and no messageID for recovery: %w", botID, err)
	}

	newFileID, newBotID, err := d.telegramClient.RecoverFileID(ctx, *msgID)
	if err != nil {
		return "", fmt.Errorf("failed to recover fileID: %w", err)
	}

	d.logger.Warn("FileID recovery occurred, database update skipped", "newFileID", newFileID, "newBotID", newBotID)

	return d.telegramClient.GetFileLink(ctx, newFileID, newBotID)
}

func (d *Downloader) fetchWithRange(ctx context.Context, url string, start, end int64) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	if start >= 0 && end >= 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	}

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		resp.Body.Close()
		return nil, fmt.Errorf("unexpected status code from Telegram: %d", resp.StatusCode)
	}

	return resp.Body, nil
}

func (d *Downloader) streamSingle(ctx context.Context, w io.Writer, info *DownloadInfo, start, end int64) error {
	url, err := d.resolveFileLink(ctx, info.TelegramFileID, info.BotID, info.TelegramMessageID, nil)
	if err != nil {
		return err
	}

	respBody, err := d.fetchWithRange(ctx, url, start, end)
	if err != nil {
		return err
	}
	defer respBody.Close()

	var reader io.Reader = respBody
	if info.IsEncrypted && info.DEK != nil && info.IV != nil {
		reader, err = d.cryptoEngine.DecryptStreamWithOffset(respBody, info.DEK, info.IV, start)
		if err != nil {
			return err
		}
	}

	_, err = io.Copy(w, reader)
	return err
}

func (d *Downloader) streamChunked(ctx context.Context, w io.Writer, info *DownloadInfo, start, end int64) error {
	currentOffset := int64(0)
	type chunkToFetch struct {
		chunk             ChunkInfo
		fetchStart        int64
		fetchEnd          int64
		byteOffsetInChunk int64
	}
	var chunksToFetch []chunkToFetch

	for _, chunk := range info.Chunks {
		chunkStart := currentOffset
		chunkEnd := currentOffset + chunk.Size - 1

		if start <= chunkEnd && end >= chunkStart {
			fetchStart := maxInt64(start, chunkStart) - chunkStart
			fetchEnd := minInt64(end, chunkEnd) - chunkStart

			chunksToFetch = append(chunksToFetch, chunkToFetch{
				chunk:             chunk,
				fetchStart:        fetchStart,
				fetchEnd:          fetchEnd,
				byteOffsetInChunk: fetchStart,
			})
		}
		currentOffset += chunk.Size
	}

	prefetchAhead := 2
	for i, chunkReq := range chunksToFetch {
		for p := i + 1; p < i+1+prefetchAhead && p < len(chunksToFetch); p++ {
			if !chunksToFetch[p].chunk.IsBuffered {
				c := chunksToFetch[p].chunk
				go func() {
					_, _ = d.resolveFileLink(context.Background(), c.TelegramFileID, c.BotID, c.TelegramMessageID, &c.ID)
				}()
			}
		}

		if chunkReq.chunk.IsBuffered && chunkReq.chunk.TempStorageKey != "" {
			reader, err := d.tempStorage.ReadRange(chunkReq.chunk.TempStorageKey, chunkReq.fetchStart, chunkReq.fetchEnd-chunkReq.fetchStart+1)
			if err != nil {
				return err
			}
			_, err = io.Copy(w, reader)
			reader.Close()
			if err != nil {
				return err
			}
		} else {
			url, err := d.resolveFileLink(ctx, chunkReq.chunk.TelegramFileID, chunkReq.chunk.BotID, chunkReq.chunk.TelegramMessageID, &chunkReq.chunk.ID)
			if err != nil {
				return err
			}

			respBody, err := d.fetchWithRange(ctx, url, chunkReq.fetchStart, chunkReq.fetchEnd)
			if err != nil {
				return err
			}

			var reader io.Reader = respBody
			if info.IsEncrypted && info.DEK != nil && chunkReq.chunk.IV != nil {
				reader, err = d.cryptoEngine.DecryptStreamWithOffset(respBody, info.DEK, chunkReq.chunk.IV, chunkReq.byteOffsetInChunk)
				if err != nil {
					respBody.Close()
					return err
				}
			}

			_, err = io.Copy(w, reader)
			respBody.Close()
			if err != nil {
				return err
			}
		}
	}

	return nil
}

func (d *Downloader) ServeStream(w http.ResponseWriter, r *http.Request, meta *pb.FileMetadata) error {
	ctx := r.Context()
	size := meta.Size

	rangeHeader := r.Header.Get("Range")
	start, end := int64(0), size-1
	isPartial := false

	if rangeHeader != "" && strings.HasPrefix(rangeHeader, "bytes=") {
		parts := strings.Split(strings.TrimPrefix(rangeHeader, "bytes="), "-")
		if len(parts) == 2 {
			isPartial = true
			if parts[0] != "" {
				start, _ = strconv.ParseInt(parts[0], 10, 64)
			}
			if parts[1] != "" {
				end, _ = strconv.ParseInt(parts[1], 10, 64)
			}
		}
	}

	if start > end || start >= size {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return nil
	}

	if end >= size {
		end = size - 1
	}

	contentLength := end - start + 1

	w.Header().Set("Content-Type", meta.MimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(contentLength, 10))
	w.Header().Set("Accept-Ranges", "bytes")

	if isPartial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	info, err := d.GetDownloadInfo(meta)
	if err != nil {
		return err
	}

	if info.IsBuffered {
		reader, err := d.tempStorage.ReadRange(info.TempStorageKey, start, contentLength)
		if err != nil {
			return err
		}
		defer reader.Close()
		_, err = io.Copy(w, reader)
		return err
	}

	if !info.IsChunked {
		return d.streamSingle(ctx, w, info, start, end)
	}
	return d.streamChunked(ctx, w, info, start, end)
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// StreamFullFile writes the entire decrypted contents of a file to w.
// Used by the ZIP worker to assemble archives. Handles buffered, single,
// and chunked files (with per-chunk decryption).
func (d *Downloader) StreamFullFile(ctx context.Context, w io.Writer, info *DownloadInfo) error {
	if info.IsBuffered {
		reader, err := d.tempStorage.Read(info.TempStorageKey)
		if err != nil {
			return err
		}
		defer reader.Close()
		_, err = io.Copy(w, reader)
		return err
	}

	if !info.IsChunked {
		return d.streamSingle(ctx, w, info, 0, info.Size-1)
	}
	return d.streamChunked(ctx, w, info, 0, info.Size-1)
}
