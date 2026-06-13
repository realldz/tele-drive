package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

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

func (d *Downloader) checkUserBandwidth(ctx context.Context, userID string, estimatedSize int64) (bool, error) {
	key := userQuotaKey(userID)

	vals, err := d.RedisClient.HMGet(ctx, key, "dailyBandwidthUsed", "dailyBandwidthLimit").Result()
	if err != nil || vals[0] == nil {
		return true, nil // cache miss — allow, not blocking
	}

	used, _ := strconv.ParseInt(vals[0].(string), 10, 64)
	limit := int64(0)
	if vals[1] != nil {
		limit, _ = strconv.ParseInt(vals[1].(string), 10, 64)
	}

	if limit > 0 && used+estimatedSize > limit {
		return false, nil
	}

	// Optimistic lock — increment
	d.RedisClient.HIncrBy(ctx, key, "dailyBandwidthUsed", estimatedSize)
	d.RedisClient.Expire(ctx, key, 1*time.Hour)

	return true, nil
}

func (d *Downloader) CheckAndLockBandwidth(c echo.Context, fileID string, fileSize int64, estimatedSize int64, hasRangeHeader bool) (*BandwidthLock, error) {
	userID := resolveUserId(c)
	ip := c.RealIP()

	if userID != "" && d.bandwidthEnabled {
		ok, _ := d.checkUserBandwidth(c.Request().Context(), userID, estimatedSize)
		if !ok {
			return nil, fmt.Errorf("BANDWIDTH_LIMIT")
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

func (d *Downloader) RefundAndReconcile(lock *BandwidthLock, actualBytes int64) {
	if lock.UserID == "" {
		return
	}

	ctx := context.Background()
	refund := lock.EstimatedSize - actualBytes
	if refund > 0 {
		d.RedisClient.HIncrBy(ctx, userQuotaKey(lock.UserID), "dailyBandwidthUsed", -refund)
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
