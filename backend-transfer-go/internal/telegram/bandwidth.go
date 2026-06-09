package telegram

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"gorm.io/gorm"
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

func formatResetAt(lastReset time.Time) string {
	return lastReset.Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
}

func (d *Downloader) CheckAndLockBandwidth(c echo.Context, fileID string, fileSize int64, estimatedSize int64, hasRangeHeader bool) (*BandwidthLock, error) {
	now := time.Now()
	ip := c.RealIP()
	userID := resolveUserId(c)

	// 1. Per-file quota check
	var file db.FileRecord
	if err := d.database.Where("id = ?", fileID).First(&file).Error; err != nil {
		return nil, err
	}

	hoursSinceReset := now.Sub(file.LastDownloadReset).Hours()
	if hoursSinceReset >= 24 {
		// Reset file limits in DB
		if err := d.database.Model(&db.FileRecord{}).Where("id = ?", fileID).Updates(map[string]interface{}{
			"downloads24h":      0,
			"bandwidthUsed24h":  0,
			"lastDownloadReset": now,
		}).Error; err != nil {
			// continue with empty results — best effort
		}
		file.Downloads24h = 0
		file.BandwidthUsed24h = 0
		file.LastDownloadReset = now
	}

	resetAtStr := formatResetAt(file.LastDownloadReset)

	if file.DownloadLimit24h != nil && file.Downloads24h >= *file.DownloadLimit24h {
		c.Response().Header().Set("X-Bandwidth-Reset", resetAtStr)
		return nil, echo.NewHTTPError(http.StatusTooManyRequests, map[string]string{
			"code":    "FILE_DOWNLOAD_LIMIT",
			"resetAt": resetAtStr,
		})
	}

	if file.BandwidthLimit24h != nil && file.BandwidthUsed24h+estimatedSize > *file.BandwidthLimit24h {
		c.Response().Header().Set("X-Bandwidth-Reset", resetAtStr)
		return nil, echo.NewHTTPError(http.StatusTooManyRequests, map[string]string{
			"code":    "FILE_BANDWIDTH_LIMIT",
			"resetAt": resetAtStr,
		})
	}

	// 2. User/Guest checking & locking
	requiresReset := false
	if userID != "" {
		// User Path
		var user db.User
		if err := d.database.Where("id = ?", userID).First(&user).Error; err != nil {
			return nil, err
		}

		userHours := now.Sub(user.LastBandwidthReset).Hours()
		requiresReset = userHours >= 24

		var currentUsed int64
		if !requiresReset {
			currentUsed = user.DailyBandwidthUsed
		}

		var limit *int64 = user.DailyBandwidthLimit
		if limit == nil {
			defaultLimit := d.settingsCache.GetCachedSettingInt64("DEFAULT_USER_BANDWIDTH", 0)
			if defaultLimit > 0 {
				limit = &defaultLimit
			}
		}

		if limit != nil && currentUsed+estimatedSize > *limit {
			userResetStr := formatResetAt(user.LastBandwidthReset)
			c.Response().Header().Set("X-Bandwidth-Reset", userResetStr)
			return nil, echo.NewHTTPError(http.StatusTooManyRequests, map[string]string{
				"code":    "USER_BANDWIDTH_LIMIT",
				"resetAt": userResetStr,
			})
		}

		// Optimistic Lock Update
		if requiresReset {
			err := d.database.Model(&db.User{}).Where("id = ?", userID).Updates(map[string]interface{}{
				"dailyBandwidthUsed": estimatedSize,
				"lastBandwidthReset": now,
			}).Error
			if err != nil {
				return nil, err
			}
		} else if estimatedSize > 0 {
			err := d.database.Model(&db.User{}).Where("id = ?", userID).Update(db.ColDailyBandwidthUsed, gorm.Expr("\"dailyBandwidthUsed\" + ?", estimatedSize)).Error
			if err != nil {
				return nil, err
			}
		}
	} else {
		// Guest Path
		defaultLimit := d.settingsCache.GetCachedSettingInt64("DEFAULT_GUEST_BANDWIDTH", 0)
		var limit *int64
		if defaultLimit > 0 {
			limit = &defaultLimit
		}

		var tracker db.GuestTracker
		err := d.database.Where("\"ipAddress\" = ?", ip).First(&tracker).Error
		if err == nil {
			// Tracker exists
			guestHours := now.Sub(tracker.LastBandwidthReset).Hours()
			requiresReset = guestHours >= 24

			var currentUsed int64
			if !requiresReset {
				currentUsed = tracker.DailyBandwidthUsed
			}

			if limit != nil && currentUsed+estimatedSize > *limit {
				guestResetStr := formatResetAt(tracker.LastBandwidthReset)
				c.Response().Header().Set("X-Bandwidth-Reset", guestResetStr)
				return nil, echo.NewHTTPError(http.StatusTooManyRequests, map[string]string{
					"code":    "GUEST_BANDWIDTH_LIMIT",
					"resetAt": guestResetStr,
				})
			}

			if requiresReset {
				err := d.database.Model(&db.GuestTracker{}).Where("\"ipAddress\" = ?", ip).Updates(map[string]interface{}{
					"dailyBandwidthUsed": estimatedSize,
					"lastBandwidthReset": now,
				}).Error
				if err != nil {
					return nil, err
				}
			} else if estimatedSize > 0 {
				err := d.database.Model(&db.GuestTracker{}).Where("\"ipAddress\" = ?", ip).Update(db.ColDailyBandwidthUsed, gorm.Expr("\"dailyBandwidthUsed\" + ?", estimatedSize)).Error
				if err != nil {
					return nil, err
				}
			}
		} else if errors.Is(err, gorm.ErrRecordNotFound) {
			// Tracker doesn't exist
			if limit != nil && estimatedSize > *limit {
				c.Response().Header().Set("X-Bandwidth-Reset", formatResetAt(now))
				return nil, echo.NewHTTPError(http.StatusTooManyRequests, map[string]string{
					"code":    "GUEST_BANDWIDTH_LIMIT",
					"resetAt": formatResetAt(now),
				})
			}

			if estimatedSize > 0 {
				tracker = db.GuestTracker{
					IPAddress:          ip,
					DailyBandwidthUsed: estimatedSize,
					LastBandwidthReset: now,
					CreatedAt:          now,
					UpdatedAt:          now,
				}
				if err := d.database.Create(&tracker).Error; err != nil {
					return nil, err
				}
			}
		} else {
			return nil, err
		}
	}

	return &BandwidthLock{
		FileID:        fileID,
		UserID:        userID,
		IP:            ip,
		EstimatedSize: estimatedSize,
		RequiresReset: requiresReset,
		CountDownload: !hasRangeHeader,
	}, nil
}

func (d *Downloader) RefundAndReconcile(lock *BandwidthLock, actualBytes int64) {
	if lock == nil {
		return
	}

	// Clean/bound actualBytes
	if actualBytes < 0 {
		actualBytes = 0
	}
	if actualBytes > lock.EstimatedSize {
		actualBytes = lock.EstimatedSize
	}

	refund := lock.EstimatedSize - actualBytes

	// 1. Refund daily user/guest bandwidth
	if refund > 0 {
		if lock.UserID != "" {
			if lock.RequiresReset {
				_ = d.database.Model(&db.User{}).Where("id = ?", lock.UserID).Update(db.ColDailyBandwidthUsed, lock.EstimatedSize-refund).Error
			} else {
				_ = d.database.Model(&db.User{}).Where("id = ?", lock.UserID).Update(db.ColDailyBandwidthUsed, gorm.Expr("\"dailyBandwidthUsed\" - ?", refund)).Error
			}
		} else {
			if lock.RequiresReset {
				_ = d.database.Model(&db.GuestTracker{}).Where("\"ipAddress\" = ?", lock.IP).Update(db.ColDailyBandwidthUsed, lock.EstimatedSize-refund).Error
			} else {
				_ = d.database.Model(&db.GuestTracker{}).Where("\"ipAddress\" = ?", lock.IP).Update(db.ColDailyBandwidthUsed, gorm.Expr("\"dailyBandwidthUsed\" - ?", refund)).Error
			}
		}
	}

	// 2. Reconcile per-file counters
	updates := map[string]interface{}{
		"bandwidthUsed24h": gorm.Expr("\"bandwidthUsed24h\" + ?", actualBytes),
	}
	if lock.CountDownload && actualBytes >= lock.EstimatedSize {
		updates["downloads24h"] = gorm.Expr("\"downloads24h\" + 1")
	}

	_ = d.database.Model(&db.FileRecord{}).Where("id = ?", lock.FileID).Updates(updates).Error
}
