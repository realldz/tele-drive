package telegram

import (
	"context"
	"errors"
	"fmt"
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

type BandwidthReport struct {
	UserID        string
	FileID        string
	ActualBytes   int64
	CountDownload bool
}

type BandwidthReporter interface {
	ReportBandwidth(report *BandwidthReport)
}

// BandwidthLimitError is returned by CheckAndLockBandwidth when a quota tier
// rejects the request. Handlers map it to HTTP 429 (XML for S3, JSON for web)
// and surface Code + ResetAt to the client. errors.As recovers it from the
// error chain returned through ServeDownload.
type BandwidthLimitError struct {
	Code    string // USER_BANDWIDTH_LIMIT | GUEST_BANDWIDTH_LIMIT | FILE_DOWNLOAD_LIMIT | FILE_BANDWIDTH_LIMIT
	ResetAt string // ISO8601; may be empty
}

func (e *BandwidthLimitError) Error() string {
	return fmt.Sprintf("BANDWIDTH_LIMIT:%s:%s", e.Code, e.ResetAt)
}

// AsBandwidthLimitError extracts a *BandwidthLimitError from an error chain,
// returning (err, true) when present. Handlers use it to detect the 429 case.
func AsBandwidthLimitError(err error) (*BandwidthLimitError, bool) {
	var ble *BandwidthLimitError
	if errors.As(err, &ble) {
		return ble, true
	}
	return nil, false
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

func userQuotaKey(userID string) string {
	return fmt.Sprintf("user:%s:quota", userID)
}

// CheckAndLockBandwidth enforces all three quota tiers (user/guest daily +
// per-file) via the QuotaResolver and, when allowed, optimistically locks the
// daily tier. Returns a *BandwidthLimitError when a tier rejects the request,
// nil-error + lock when allowed. Bandwidth disabled or no resolver → pass-through.
func (d *Downloader) CheckAndLockBandwidth(c echo.Context, fileID string, fileSize int64, estimatedSize int64, hasRangeHeader bool) (*BandwidthLock, error) {
	userID := resolveUserId(c)
	ip := c.RealIP()

	if d.bandwidthEnabled && d.quotaResolver != nil {
		ctx := context.WithValue(c.Request().Context(), quotaRequestIDKey,
			c.Response().Header().Get("X-Request-ID"))
		decision := d.quotaResolver.CheckAndLock(ctx, userID, ip, fileID, estimatedSize)
		if !decision.Allowed {
			return nil, &BandwidthLimitError{Code: decision.Code, ResetAt: decision.ResetAt}
		}
	}

	return &BandwidthLock{
		FileID:        fileID,
		UserID:        userID,
		IP:            ip,
		EstimatedSize: estimatedSize,
		RequiresReset: false,
		CountDownload: !hasRangeHeader,
	}, nil
}

// RefundAndReconcile returns over-locked bytes to the daily hash and reports
// actual usage for DB reconciliation. The daily refund targets the user hash
// (user:{id}:quota) or, for guests, the guest hash (guest:{ip}:quota) — the
// QuotaResolver locked whichever applies. Reporting runs for guests too: the
// per-file FileRecord counters still update (NestJS no-ops the empty-userId
// row), so a file's bandwidthUsed24h/downloads24h reflect anonymous traffic.
func (d *Downloader) RefundAndReconcile(lock *BandwidthLock, actualBytes int64) {
	if lock.UserID == "" && lock.IP == "" {
		return
	}

	ctx := context.Background()
	if refund := lock.EstimatedSize - actualBytes; refund > 0 {
		key := userQuotaKey(lock.UserID)
		if lock.UserID == "" {
			key = guestQuotaCacheKey(lock.IP)
		}
		d.RedisClient.HIncrBy(ctx, key, "dailyBandwidthUsed", -refund)
	}

	if d.batchReporter != nil {
		d.batchReporter.ReportBandwidth(&BandwidthReport{
			UserID:        lock.UserID,
			FileID:        lock.FileID,
			ActualBytes:   actualBytes,
			CountDownload: lock.CountDownload,
		})
	}
}
