package handler

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
)

// S3HeadObject serves HEAD /:bucket/*key (S3 HeadObject). Identical resolution
// to S3GetObject but writes headers only — no body. aws-cli / SDKs call this
// before cp / sync to size the transfer, so it must return the same ETag,
// Content-Type, Content-Length, and Last-Modified that a GET would.
func (h *FileHandler) S3HeadObject(c echo.Context) error {
	start := time.Now()
	bucket := c.Param("bucket")
	key := s3ObjectKey(c, bucket)

	userID, err := h.s3Authenticate(c)
	if err != nil {
		// HEAD has no body — emit the status only; clients infer the S3 code.
		return c.NoContent(s3AuthErrorStatus(err))
	}

	log := h.logger.With(
		"op", "s3.head",
		"userId", userID,
		"bucket", bucket,
		"key", key,
		"requestId", c.Response().Header().Get("X-Request-ID"),
	)
	log.Debug("s3 HeadObject start")

	resolveCtx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()
	obj, err := h.grpcClient.ResolveS3Object(resolveCtx, userID, bucket, key)
	if err != nil {
		log.Error("s3 head resolve error", "error", err)
		return c.NoContent(http.StatusInternalServerError)
	}
	if !obj.Found {
		log.Warn("s3 head resolve miss")
		return c.NoContent(http.StatusNotFound)
	}

	res := c.Response()
	if obj.MimeType != "" {
		res.Header().Set("Content-Type", obj.MimeType)
	} else {
		res.Header().Set("Content-Type", "application/octet-stream")
	}
	res.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	res.Header().Set("ETag", obj.Etag)
	if obj.LastModified != "" {
		res.Header().Set("Last-Modified", obj.LastModified)
	}
	res.Header().Set("Accept-Ranges", "bytes")

	log.Info("s3 HeadObject ok",
		"fileId", obj.FileId, "size", obj.Size, "durationMs", time.Since(start).Milliseconds())
	return c.NoContent(http.StatusOK)
}
