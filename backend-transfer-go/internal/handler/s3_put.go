package handler

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
)

// isAwsChunked reports whether the request body uses the aws-chunked streaming
// encoding (aws-cli / SDK streaming uploads). Mirrors NestJS isAwsChunkedRequest.
func isAwsChunked(c echo.Context) bool {
	h := c.Request().Header
	enc := strings.ToLower(h.Get("Content-Encoding"))
	sha := strings.ToUpper(h.Get("X-Amz-Content-Sha256"))
	return strings.Contains(enc, "aws-chunked") ||
		strings.HasPrefix(sha, "STREAMING-AWS4-HMAC-SHA256-PAYLOAD") ||
		h.Get("X-Amz-Decoded-Content-Length") != ""
}

// s3PutContentLength returns the decoded payload length, preferring
// x-amz-decoded-content-length (set on aws-chunked uploads) over Content-Length.
func s3PutContentLength(c echo.Context) int64 {
	if v := c.Request().Header.Get("X-Amz-Decoded-Content-Length"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			return n
		}
	}
	if n := c.Request().ContentLength; n > 0 {
		return n
	}
	return 0
}

// S3PutObject serves PUT /:bucket/*key by ingesting the body directly (encrypt
// → Telegram), replacing the legacy NestJS 307 redirect. Multipart UploadPart
// (?uploadId&partNumber) and CopyObject (x-amz-copy-source) are left to NestJS
// via nginx routing — this handler defers those back with a 501 so a
// mis-routed request fails loudly rather than corrupting data.
func (h *FileHandler) S3PutObject(c echo.Context) error {
	start := time.Now()
	bucket := c.Param("bucket")
	key := s3ObjectKey(c, bucket)

	// Defer multipart / copy to the control plane (NestJS) — not ingested here.
	q := c.Request().URL.Query()
	if q.Get("uploadId") != "" || c.Request().Header.Get("X-Amz-Copy-Source") != "" {
		return s3ErrorXML(c, http.StatusNotImplemented, "NotImplemented",
			"This operation is handled by the control plane.")
	}

	userID, err := h.s3Authenticate(c)
	if err != nil {
		return s3AuthErrorToXML(c, err)
	}

	requestID := c.Response().Header().Get("X-Request-ID")
	contentLength := s3PutContentLength(c)
	contentType := c.Request().Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	contentMd5 := c.Request().Header.Get("Content-MD5")

	log := h.logger.With(
		"op", "s3.put",
		"requestId", requestID,
		"userId", userID,
		"bucket", bucket,
		"key", key,
	)
	log.Info("s3 PutObject received",
		"contentLength", contentLength,
		"hasContentMd5", contentMd5 != "",
		"awsChunked", isAwsChunked(c))

	// 1. Provision the destination (folder marker for zero-byte, else uploading
	// FileRecord with encryption keyed upfront) via the control plane.
	prepCtx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()
	prep, err := h.grpcClient.PrepareS3Put(prepCtx, &pb.PrepareS3PutRequest{
		UserId:        userID,
		Bucket:        bucket,
		Key:           key,
		MimeType:      contentType,
		ContentLength: contentLength,
	})
	if err != nil {
		log.Error("s3 put prepare failed", "stage", "resolve", "error", err)
		return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to prepare upload.")
	}

	// Zero-byte object → folder marker. Nothing to ingest; PrepareS3Put already
	// created the folder chain and returned an empty fileId.
	if prep.FileId == "" {
		log.Info("s3 PutObject folder marker", "folderId", prep.FolderId)
		c.Response().Header().Set("ETag", `"d41d8cd98f00b204e9800998ecf8427e"`) // md5 of empty
		return c.NoContent(http.StatusOK)
	}

	log.Debug("s3 put resolved", "stage", "resolve", "fileId", prep.FileId,
		"folderId", prep.FolderId, "isEncrypted", prep.IsEncrypted)

	// 2. Build the body reader (decode aws-chunked if needed).
	var body io.Reader = c.Request().Body
	if isAwsChunked(c) {
		body = newAwsChunkedReader(c.Request().Body)
	}
	defer c.Request().Body.Close()

	// 3. Encrypt (if provisioned) + count + md5 while streaming to Telegram.
	var dek []byte
	if prep.IsEncrypted {
		dek, err = h.cryptoEngine.DecryptKey(prep.EncryptedKey)
		if err != nil {
			log.Error("s3 put dek decrypt failed", "stage", "encrypt", "fileId", prep.FileId, "error", err)
			return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to prepare encryption.")
		}
	}
	ivBytes, _ := h.cryptoEngine.GenerateIv()

	hash := md5.New()
	counter := &streamCounter{r: body, hash: hash}

	var uploadStream io.Reader = counter
	if prep.IsEncrypted {
		uploadStream, err = h.cryptoEngine.EncryptStream(counter, dek, ivBytes)
		if err != nil {
			log.Error("s3 put encrypt init failed", "stage", "encrypt", "fileId", prep.FileId, "error", err)
			return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to init encryption.")
		}
	}

	log.Debug("s3 put telegram upload start", "stage", "telegram", "fileId", prep.FileId)
	tgStart := time.Now()
	telegramFileID, telegramMessageID, botID, err := h.telegramClient.UploadFile(
		c.Request().Context(), uploadStream, prep.FileId, contentLength)
	if err != nil {
		log.Error("s3 put telegram upload failed", "stage", "telegram", "fileId", prep.FileId, "error", err)
		return s3ErrorXML(c, http.StatusBadGateway, "InternalError", "Upload to storage backend failed.")
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)
	log.Info("s3 put telegram upload done", "stage", "telegram", "fileId", prep.FileId,
		"botId", botID, "telegramFileId", telegramFileID, "bytes", counter.count,
		"durationMs", time.Since(tgStart).Milliseconds())

	// 4. Content-MD5 verification (if the client sent one). On mismatch, abort:
	// the FileRecord is left in 'uploading' and reaped by the stale-upload cron.
	if contentMd5 != "" {
		raw, derr := base64.StdEncoding.DecodeString(contentMd5)
		if derr != nil || hex.EncodeToString(raw) != md5Hex {
			log.Warn("s3 put bad digest", "stage", "verify", "fileId", prep.FileId,
				"expected", contentMd5, "computedHex", md5Hex)
			return s3ErrorXML(c, http.StatusBadRequest, "BadDigest",
				"The Content-MD5 you specified did not match what we received.")
		}
	}

	// 5. Finalize: mark complete, bump quota, overwrite prior versions.
	reportCtx, reportCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer reportCancel()
	if err := h.grpcClient.ReportS3PutComplete(reportCtx, &pb.ReportS3PutCompleteRequest{
		FileId:            prep.FileId,
		TelegramFileId:    telegramFileID,
		TelegramMessageId: int32(telegramMessageID),
		BotId:             botID,
		EncryptionIv:      hex.EncodeToString(ivBytes),
		Size:              counter.count,
		Etag:              etag,
		IsChunked:         false,
		TotalChunks:       0,
	}); err != nil {
		log.Error("s3 put report failed", "stage", "report", "fileId", prep.FileId, "error", err)
		return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to finalize upload.")
	}

	log.Info("s3 PutObject complete", "stage", "report", "fileId", prep.FileId,
		"bytes", counter.count, "etag", etag, "durationMs", time.Since(start).Milliseconds())
	c.Response().Header().Set("ETag", etag)
	return c.NoContent(http.StatusOK)
}
