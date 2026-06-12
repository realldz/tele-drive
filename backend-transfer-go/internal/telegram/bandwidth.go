package telegram

import (
	"strings"

	"github.com/labstack/echo/v4"
)

type BandwidthLock struct {
	FileID        string
	UserID        string
	IP            string
	EstimatedSize int64
	RequiresReset bool
	CountDownload bool
}

func resolveUserId(c echo.Context) string {
	if s3Pub, ok := c.Get("s3PublicAccess").(bool); ok && s3Pub {
		return ""
	}
	if u, ok := c.Get("userId").(string); ok && u != "" {
		return u
	}
	if s, ok := c.Get("s3UserId").(string); ok && s != "" {
		return s
	}
	if sub, ok := c.Get("streamUserSubject").(string); ok && sub != "" {
		if !strings.HasPrefix(sub, "guest:") {
			return sub
		}
	}
	return ""
}

func (d *Downloader) CheckAndLockBandwidth(c echo.Context, fileID string, fileSize int64, estimatedSize int64, hasRangeHeader bool) (*BandwidthLock, error) {
	// Bypassed local database-level bandwidth checking in Go transfer service,
	// as user bandwidth checking is fully handled on the NestJS Core API gateway.
	userID := resolveUserId(c)
	ip := c.RealIP()

	return &BandwidthLock{
		FileID:        fileID,
		UserID:        userID,
		IP:            ip,
		EstimatedSize: estimatedSize,
		RequiresReset: false,
		CountDownload: !hasRangeHeader,
	}, nil
}

func (d *Downloader) RefundAndReconcile(lock *BandwidthLock, actualBytes int64) {
	// No-op
}
