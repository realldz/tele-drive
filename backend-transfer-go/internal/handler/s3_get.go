package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/s3auth"
)

// s3ErrorXML writes an S3-compatible <Error> XML body with the given HTTP
// status. Mirrors the AWS error shape so aws-cli / SDKs parse it correctly
// instead of treating the response as a generic failure.
func s3ErrorXML(c echo.Context, status int, code, message string) error {
	xml := fmt.Sprintf(
		`<?xml version="1.0" encoding="UTF-8"?>`+
			`<Error><Code>%s</Code><Message>%s</Message><Resource>%s</Resource><RequestId>%s</RequestId></Error>`,
		code, message, c.Request().URL.Path, c.Response().Header().Get("X-Request-ID"),
	)
	c.Response().Header().Set("Content-Type", "application/xml")
	return c.String(status, xml)
}

// s3AuthErrorToXML maps a SigV4 verification sentinel to its S3 wire response.
func s3AuthErrorToXML(c echo.Context, err error) error {
	switch {
	case errors.Is(err, s3auth.ErrMalformed):
		return s3ErrorXML(c, http.StatusBadRequest, "InvalidRequest", "Malformed SigV4 request.")
	case errors.Is(err, s3auth.ErrCredentialNotFound), errors.Is(err, s3auth.ErrCredentialInactive):
		return s3ErrorXML(c, http.StatusForbidden, "InvalidAccessKeyId", "The AWS access key Id you provided does not exist in our records.")
	case errors.Is(err, s3auth.ErrSignatureMismatch):
		return s3ErrorXML(c, http.StatusForbidden, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.")
	case errors.Is(err, s3auth.ErrSkewTooLarge):
		return s3ErrorXML(c, http.StatusForbidden, "RequestTimeTooSkewed", "The difference between the request time and the current time is too large.")
	case errors.Is(err, s3auth.ErrExpired):
		return s3ErrorXML(c, http.StatusForbidden, "AccessDenied", "Request has expired.")
	default:
		return s3ErrorXML(c, http.StatusForbidden, "AccessDenied", "Access Denied.")
	}
}

// s3Authenticate runs SigV4 verification on the request and stores the
// authenticated userId in the echo context (key "s3UserId"). Returns an S3 XML
// error response on failure. A per-request correlation ID is generated and
// echoed back via X-Request-ID so the verifier's structured logs can be tied
// to the HTTP access log.
func (h *FileHandler) s3Authenticate(c echo.Context) (string, error) {
	requestID := c.Response().Header().Get("X-Request-ID")
	if requestID == "" {
		requestID = generateUUID()
		c.Response().Header().Set("X-Request-ID", requestID)
	}

	result, err := h.s3Verifier.Verify(c.Request().Context(), c.Request(), requestID)
	if err != nil {
		return "", err
	}
	c.Set("s3UserId", result.UserID)
	return result.UserID, nil
}

// s3ObjectKey extracts the object key from the path, stripping the leading
// "/:bucket/" prefix. Echo's "*" param can mangle encoded slashes, so we derive
// the key from the raw URL path instead.
func s3ObjectKey(c echo.Context, bucket string) string {
	return strings.TrimPrefix(c.Request().URL.Path, "/"+bucket+"/")
}

// S3GetObject serves GET /:bucket/*key by streaming the file directly from
// Telegram (decrypting on the fly), replacing the legacy NestJS 307 redirect.
func (h *FileHandler) S3GetObject(c echo.Context) error {
	start := time.Now()
	bucket := c.Param("bucket")
	key := s3ObjectKey(c, bucket)

	userID, err := h.s3Authenticate(c)
	if err != nil {
		return s3AuthErrorToXML(c, err)
	}

	log := h.logger.With(
		"op", "s3.get",
		"userId", userID,
		"bucket", bucket,
		"key", key,
		"requestId", c.Response().Header().Get("X-Request-ID"),
	)
	log.Info("s3 GetObject start", "range", c.Request().Header.Get("Range"))

	// 1. Resolve (bucket, key) → fileId via NestJS control plane.
	resolveCtx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()
	obj, err := h.grpcClient.ResolveS3Object(resolveCtx, userID, bucket, key)
	if err != nil {
		log.Error("s3 resolve error", "error", err)
		return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to resolve object.")
	}
	if !obj.Found {
		log.Warn("s3 resolve miss")
		return s3ErrorXML(c, http.StatusNotFound, "NoSuchKey", "The specified key does not exist.")
	}
	log.Debug("s3 resolved", "fileId", obj.FileId, "size", obj.Size, "etag", obj.Etag)

	// 2. Fetch full file metadata (chunks, IV, encrypted key).
	meta, err := h.GetCachedMetadata(c.Request().Context(), obj.FileId)
	if err != nil {
		log.Error("s3 metadata fetch failed", "fileId", obj.FileId, "error", err)
		return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to fetch file metadata.")
	}
	log.Debug("s3 metadata fetched",
		"fileId", meta.Id, "isChunked", meta.IsChunked, "totalChunks", meta.TotalChunks, "isEncrypted", meta.IsEncrypted)

	info, err := h.downloader.GetDownloadInfo(meta)
	if err != nil {
		log.Error("s3 download info failed", "fileId", obj.FileId, "error", err)
		return s3ErrorXML(c, http.StatusInternalServerError, "InternalError", "Failed to prepare download.")
	}

	// 3. Set S3 object headers BEFORE the body is written. ServeDownload flushes
	// all response headers on WriteHeader, so headers set here are included.
	c.Response().Header().Set("ETag", obj.Etag)
	if obj.LastModified != "" {
		c.Response().Header().Set("Last-Modified", obj.LastModified)
	}

	// 4. Stream (ServeDownload handles Range, bandwidth lock, and Content-Type).
	rangeHeader := c.Request().Header.Get("Range")
	if streamErr := h.downloader.ServeDownload(c, info, rangeHeader, "inline"); streamErr != nil {
		log.Error("s3 stream error", "fileId", obj.FileId, "error", streamErr, "durationMs", time.Since(start).Milliseconds())
		return streamErr
	}

	log.Info("s3 GetObject done", "bytesWritten", c.Response().Size, "durationMs", time.Since(start).Milliseconds())
	return nil
}
