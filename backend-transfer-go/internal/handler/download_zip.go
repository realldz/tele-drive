package handler

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
)

// zipStreamActivePrefix mirrors ZIP_STREAM_ACTIVE_PREFIX in the NestJS
// download-zip service. Go INCRs this on part-stream start and DECRs on end so
// the NestJS cleanup cron can avoid deleting parts mid-download. A TTL bounds
// any leak if a DECR is ever missed (e.g. process crash mid-stream).
const zipStreamActivePrefix = "zip:stream:active:"

// zipStreamActiveTTL caps how long a single part stream can hold the active
// flag. Longer than any realistic part download, short enough that a missed
// DECR self-heals well before the next cleanup window.
const zipStreamActiveTTL = 2 * time.Hour

// ServeZipPart streams a single assembled ZIP part to the client. ZIP assembly
// and serving are Go-owned; the job's serve metadata (status, expiry, parts)
// lives in NestJS, fetched over gRPC. The active-stream counter in Redis tells
// the NestJS cleanup cron not to delete parts while a download is in flight.
func (h *FileHandler) ServeZipPart(c echo.Context) error {
	jobID := c.Param("id")
	partIndex, err := strconv.Atoi(c.Param("partIndex"))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid part index"})
	}

	ctx := c.Request().Context()

	job, err := h.grpcClient.GetZipJob(ctx, jobID)
	if err != nil {
		h.logger.Error("gRPC GetZipJob failed", "jobId", jobID, "error", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Failed to resolve ZIP job"})
	}
	if !job.Found {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Job not found"})
	}
	if job.Status != "ready" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "ZIP is not ready"})
	}
	if job.ExpiresAt != "" {
		if exp, perr := time.Parse(time.RFC3339, job.ExpiresAt); perr == nil && exp.Before(time.Now()) {
			return c.JSON(http.StatusBadRequest, map[string]string{"message": "Download link has expired"})
		}
	}

	var partKey string
	var partSize int64
	for _, p := range job.Parts {
		if int(p.Index) == partIndex {
			partKey = p.Key
			partSize = p.Size
			break
		}
	}
	if partKey == "" {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Part not found"})
	}

	// Mark this stream active so the NestJS cleanup cron skips the job's parts
	// while the download is in flight. DECR on every exit path via defer; the TTL
	// is the backstop if the process dies before the defer runs.
	activeKey := zipStreamActivePrefix + jobID
	h.redisClient.Incr(ctx, activeKey)
	h.redisClient.Expire(ctx, activeKey, zipStreamActiveTTL)
	defer func() {
		if n, derr := h.redisClient.Decr(context.Background(), activeKey).Result(); derr == nil && n <= 0 {
			h.redisClient.Del(context.Background(), activeKey)
		}
	}()

	stream, err := h.tempStorage.Read(partKey)
	if err != nil {
		h.logger.Error("Failed to open ZIP part", "jobId", jobID, "part", partIndex, "key", partKey, "error", err)
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Part not found"})
	}
	defer stream.Close()

	filename := zipPartFilename(job.CreatedAt, partIndex, len(job.Parts))

	resp := c.Response()
	resp.Header().Set(echo.HeaderContentType, "application/zip")
	resp.Header().Set(echo.HeaderContentLength, strconv.FormatInt(partSize, 10))
	resp.Header().Set(echo.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="%s"`, filename))
	resp.WriteHeader(http.StatusOK)

	// io.Copy stops with an error the moment the client disconnects; the defer
	// still releases the active-stream counter. Log non-abort errors only.
	if _, err := io.Copy(resp, stream); err != nil {
		h.logger.Debug("ZIP part stream ended early", "jobId", jobID, "part", partIndex, "error", err)
	}
	return nil
}

// zipPartFilename builds the download_<timestamp>[_partNN].zip name. createdAt
// is the job's ISO8601 creation time; a parse failure falls back to now so a
// malformed timestamp never blocks the download.
func zipPartFilename(createdAt string, partIndex, partCount int) string {
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t = time.Now()
	}
	ts := t.Format("20060102_150405")
	if partCount > 1 {
		return fmt.Sprintf("download_%s_part%02d.zip", ts, partIndex+1)
	}
	return fmt.Sprintf("download_%s.zip", ts)
}
