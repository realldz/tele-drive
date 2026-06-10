package telegram

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
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
	database       *db.DB
	settingsCache  *db.SettingsCache
	httpClient     *http.Client
}

func NewDownloader(
	telegramClient *TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	database *db.DB,
	settingsCache *db.SettingsCache,
) *Downloader {
	return &Downloader{
		telegramClient: telegramClient,
		cryptoEngine:   cryptoEngine,
		tempStorage:    tempStorage,
		database:       database,
		settingsCache:  settingsCache,
		httpClient: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}
}

func (d *Downloader) GetDownloadInfo(fileRecord db.FileRecord) (*DownloadInfo, error) {
	var dek []byte
	var err error
	if fileRecord.IsEncrypted && fileRecord.EncryptedKey != nil {
		dek, err = d.cryptoEngine.DecryptKey(*fileRecord.EncryptedKey)
		if err != nil {
			return nil, err
		}
	}

	var iv []byte
	if fileRecord.EncryptionIv != nil {
		iv, _ = hex.DecodeString(*fileRecord.EncryptionIv)
	}

	if fileRecord.Status == "buffered" && fileRecord.TempStorageKey != nil {
		return &DownloadInfo{
			ID:             fileRecord.ID,
			Filename:       fileRecord.Filename,
			Size:           fileRecord.Size,
			MimeType:       fileRecord.MimeType,
			IsBuffered:     true,
			TempStorageKey: *fileRecord.TempStorageKey,
			IsChunked:      false,
		}, nil
	}

	if !fileRecord.IsChunked && fileRecord.TelegramFileID != nil {
		return &DownloadInfo{
			ID:                fileRecord.ID,
			Filename:          fileRecord.Filename,
			Size:              fileRecord.Size,
			MimeType:          fileRecord.MimeType,
			IsBuffered:        false,
			IsChunked:         false,
			TelegramFileID:    *fileRecord.TelegramFileID,
			BotID:             fileRecord.BotID,
			TelegramMessageID: fileRecord.TelegramMessageID,
			IsEncrypted:       fileRecord.IsEncrypted,
			DEK:               dek,
			IV:                iv,
		}, nil
	}

	// Load chunks
	var dbChunks []db.FileChunk
	if err := d.database.Where("\"fileId\" = ?", fileRecord.ID).Order("\"chunkIndex\" ASC").Find(&dbChunks).Error; err != nil {
		return nil, err
	}

	chunks := make([]ChunkInfo, len(dbChunks))
	for i, c := range dbChunks {
		var chunkIv []byte
		if c.EncryptionIv != nil {
			chunkIv, _ = hex.DecodeString(*c.EncryptionIv)
		}

		var chunkFileID string
		if c.TelegramFileID != nil {
			chunkFileID = *c.TelegramFileID
		}

		var tempKey string
		if c.TempStorageKey != nil {
			tempKey = *c.TempStorageKey
		}

		chunks[i] = ChunkInfo{
			ID:                c.ID,
			TelegramFileID:    chunkFileID,
			BotID:             c.BotID,
			TelegramMessageID: c.TelegramMessageID,
			IV:                chunkIv,
			Size:              int64(c.Size),
			IsBuffered:        c.Status == "buffered",
			TempStorageKey:    tempKey,
		}
	}

	return &DownloadInfo{
		ID:          fileRecord.ID,
		Filename:    fileRecord.Filename,
		Size:        fileRecord.Size,
		MimeType:    fileRecord.MimeType,
		IsBuffered:  false,
		IsChunked:   true,
		Chunks:      chunks,
		IsEncrypted: fileRecord.IsEncrypted,
		DEK:         dek,
	}, nil
}

func (d *Downloader) ServeDownload(c echo.Context, info *DownloadInfo, rangeHeader string, disposition string) error {
	fileSize := info.Size
	start := int64(0)
	end := fileSize - 1

	hasRangeHeader := rangeHeader != ""
	isRange := false
	if rangeHeader != "" {
		parts := strings.Split(rangeHeader, "=")
		if len(parts) == 2 && parts[0] == "bytes" {
			rangeParts := strings.Split(parts[1], "-")
			if len(rangeParts) == 2 {
				if rangeParts[0] == "" {
					// Suffix range: bytes=-500
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

	// Lock & Check Bandwidth
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

	// Set ALL headers BEFORE WriteHeader — Go discards headers set after it
	res.Header().Set("Accept-Ranges", "bytes")
	res.Header().Set("Content-Length", strconv.FormatInt(contentLength, 10))
	res.Header().Set("Content-Type", info.MimeType)

	if disposition == "attachment" {
		res.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, url.QueryEscape(info.Filename)))
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

	if info.IsBuffered {
		reader, err := d.tempStorage.ReadRange(info.TempStorageKey, start, contentLength)
		if err != nil {
			return err
		}
		defer reader.Close()
		_, err = io.Copy(res.Writer, reader)
		return err
	}

	if !info.IsChunked {
		return d.streamSingle(ctx, res.Writer, info, start, end)
	}
	return d.streamChunked(ctx, res.Writer, info, start, end)
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

	if chunkDbID != nil {
		go func() {
			_ = d.database.Model(&db.FileChunk{}).Where("id = ?", *chunkDbID).Updates(map[string]interface{}{
				"telegramFileId": newFileID,
				"botId":          newBotID,
			}).Error
		}()
	} else {
		go func() {
			_ = d.database.Model(&db.FileRecord{}).Where("\"telegramFileId\" = ?", fileID).Updates(map[string]interface{}{
				"telegramFileId": newFileID,
				"botId":          newBotID,
			}).Error
		}()
	}

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

	// Prefetch links ahead asynchronously
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
