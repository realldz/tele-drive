package cron

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
	"gorm.io/gorm"
)

type ZipPartInfo struct {
	Key   string `json:"key"`
	Size  int64  `json:"size"`
	Index int    `json:"index"`
}

func StartCronJobs(
	ctx context.Context,
	database *db.DB,
	telegramClient *telegram.TelegramClient,
	tempStorage *storage.TempStorage,
	settingsCache *db.SettingsCache,
	logger *slog.Logger,
) {
	// 1. ZIP cleanup ticker: runs every 5 minutes
	go runTickerJob(ctx, 5*time.Minute, func() {
		cleanupExpiredZips(database, tempStorage, logger)
	})

	// 2. Buffer expiration ticker: runs every 15 minutes
	go runTickerJob(ctx, 15*time.Minute, func() {
		expireStaleBufferedFiles(database, settingsCache, logger)
	})

	// 3. Stale upload cleanup ticker: runs every 6 hours
	go runTickerJob(ctx, 6*time.Hour, func() {
		handleStaleUploadCleanup(database, telegramClient, tempStorage, logger)
	})

	// 4. Trash cleanup: runs at 2:00 AM daily
	go runDailyJob(ctx, 2, 0, func() {
		handleTrashCleanup(database, telegramClient, tempStorage, logger)
	})
}

func runTickerJob(ctx context.Context, interval time.Duration, fn func()) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fn()
		}
	}
}

func runDailyJob(ctx context.Context, hour, minute int, fn func()) {
	for {
		now := time.Now()
		nextRun := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
		if now.After(nextRun) {
			nextRun = nextRun.Add(24 * time.Hour)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(nextRun.Sub(now)):
			fn()
		}
	}
}

func cleanupExpiredZips(database *db.DB, tempStorage *storage.TempStorage, logger *slog.Logger) {
	logger.Info("Starting expired ZIP cleanup...")
	now := time.Now()

	var expiredJobs []db.DownloadJob
	err := database.Where("status = ? AND \"expiresAt\" < ?", "ready", now).Find(&expiredJobs).Error
	if err == nil {
		for _, job := range expiredJobs {
			var parts []ZipPartInfo
			if job.ZipParts != "" {
				_ = json.Unmarshal([]byte(job.ZipParts), &parts)
			}

			for _, p := range parts {
				_ = tempStorage.Delete(p.Key)
			}

			database.Model(&db.DownloadJob{}).Where("id = ?", job.ID).Update("status", "expired")
			logger.Info("Expired ZIP cleaned up", "jobId", job.ID)
		}
	}

	stuckCutoff := now.Add(-2 * time.Hour)
	var stuckJobs []db.DownloadJob
	err = database.Where("status IN ? AND \"createdAt\" < ?", []string{"pending", "collecting", "zipping"}, stuckCutoff).Find(&stuckJobs).Error
	if err == nil {
		for _, job := range stuckJobs {
			var parts []ZipPartInfo
			if job.ZipParts != "" {
				_ = json.Unmarshal([]byte(job.ZipParts), &parts)
			}

			for _, p := range parts {
				_ = tempStorage.Delete(p.Key)
			}

			database.Model(&db.DownloadJob{}).Where("id = ?", job.ID).Updates(map[string]interface{}{
				"status":       "failed",
				"errorMessage": "Job timed out",
			})
			logger.Warn("Marked stuck ZIP job as failed", "jobId", job.ID)
		}
	}
}

func expireStaleBufferedFiles(database *db.DB, settingsCache *db.SettingsCache, logger *slog.Logger) {
	logger.Info("Starting expired stale buffered files cleanup...")
	bufferTtlHours := settingsCache.GetCachedSettingInt("BUFFER_TTL_HOURS", 24)
	cutoff := time.Now().Add(-time.Duration(bufferTtlHours) * time.Hour)

	var count int64
	database.Model(&db.FileRecord{}).Where("status = ? AND \"createdAt\" < ?", "buffered", cutoff).Count(&count)
	if count > 0 {
		err := database.Model(&db.FileRecord{}).Where("status = ? AND \"createdAt\" < ?", "buffered", cutoff).Update("status", "buffer_failed").Error
		if err != nil {
			logger.Error("Failed to expire stale buffered files", "error", err)
		} else {
			logger.Warn("Expired stale buffered files", "count", count, "ttlHours", bufferTtlHours)
		}
	}
}

func handleStaleUploadCleanup(
	database *db.DB,
	telegramClient *telegram.TelegramClient,
	tempStorage *storage.TempStorage,
	logger *slog.Logger,
) {
	logger.Info("Starting stale upload cleanup...")
	cutoff := time.Now().Add(-1 * time.Hour)

	var staleUploads []db.FileRecord
	err := database.Where("status IN ? AND \"updatedAt\" < ?", []string{"uploading", "aborted", "buffer_failed"}, cutoff).Find(&staleUploads).Error
	if err != nil {
		logger.Error("Failed to query stale uploads", "error", err)
		return
	}

	if len(staleUploads) == 0 {
		logger.Info("No stale uploads found.")
		return
	}

	cleaned := 0
	ctx := context.Background()

	for _, file := range staleUploads {
		tryClean := func() error {
			if file.TempStorageKey != nil {
				_ = tempStorage.Delete(*file.TempStorageKey)
			}

			var chunks []db.FileChunk
			if err := database.Where("\"fileId\" = ?", file.ID).Find(&chunks).Error; err == nil {
				for _, chunk := range chunks {
					if chunk.TempStorageKey != nil {
						_ = tempStorage.Delete(*chunk.TempStorageKey)
					}
					if chunk.TelegramMessageID != nil {
						_ = telegramClient.DeleteMessage(ctx, *chunk.TelegramMessageID, chunk.BotID)
					}
				}
			}

			if file.TelegramMessageID != nil {
				_ = telegramClient.DeleteMessage(ctx, *file.TelegramMessageID, file.BotID)
			}

			return database.Transaction(func(tx *gorm.DB) error {
				if err := tx.Where("\"fileId\" = ?", file.ID).Delete(&db.FileChunk{}).Error; err != nil {
					return err
				}
				return tx.Where("id = ?", file.ID).Delete(&db.FileRecord{}).Error
			})
		}

		if err := tryClean(); err != nil {
			logger.Error("Failed to clean stale upload", "fileId", file.ID, "error", err)
		} else {
			cleaned++
			logger.Info("Cleaned stale upload", "filename", file.Filename, "fileId", file.ID)
		}
	}

	logger.Info("Stale upload cleanup completed", "cleaned", cleaned, "total", len(staleUploads))
}

func handleTrashCleanup(
	database *db.DB,
	telegramClient *telegram.TelegramClient,
	tempStorage *storage.TempStorage,
	logger *slog.Logger,
) {
	logger.Info("Starting trash cleanup cron job...")
	cutoffDate := time.Now().Add(-7 * 24 * time.Hour)
	ctx := context.Background()

	var expiredFiles []db.FileRecord
	err := database.Where("\"deletedAt\" IS NOT NULL AND \"deletedAt\" < ?", cutoffDate).Find(&expiredFiles).Error
	if err == nil {
		for _, file := range expiredFiles {
			_ = database.Model(&db.User{}).Where("id = ?", file.UserID).Update(db.ColIsCleaningTrash, true)

			tryDelete := func() error {
				if file.TempStorageKey != nil {
					_ = tempStorage.Delete(*file.TempStorageKey)
				}

				var chunks []db.FileChunk
				if err := database.Where("\"fileId\" = ?", file.ID).Find(&chunks).Error; err == nil {
					for _, chunk := range chunks {
						if chunk.TempStorageKey != nil {
							_ = tempStorage.Delete(*chunk.TempStorageKey)
						}
						if chunk.TelegramMessageID != nil {
							_ = telegramClient.DeleteMessage(ctx, *chunk.TelegramMessageID, chunk.BotID)
						}
					}
				}

				if file.TelegramMessageID != nil {
					_ = telegramClient.DeleteMessage(ctx, *file.TelegramMessageID, file.BotID)
				}

				return database.Transaction(func(tx *gorm.DB) error {
					if err := tx.Where("\"fileId\" = ?", file.ID).Delete(&db.FileChunk{}).Error; err != nil {
						return err
					}
					if err := tx.Where("id = ?", file.ID).Delete(&db.FileRecord{}).Error; err != nil {
						return err
					}

					if file.Status == "complete" {
						return tx.Model(&db.User{}).Where("id = ?", file.UserID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" - ?", file.Size)).Error
					}
					return nil
				})
			}

			if err := tryDelete(); err != nil {
				logger.Error("Failed to permanently delete file from trash", "fileId", file.ID, "error", err)
			}

			_ = database.Model(&db.User{}).Where("id = ?", file.UserID).Update(db.ColIsCleaningTrash, false)
		}
	}

	var expiredFolders []db.Folder
	err = database.Where("\"deletedAt\" IS NOT NULL AND \"deletedAt\" < ?", cutoffDate).Find(&expiredFolders).Error
	if err == nil {
		for _, folder := range expiredFolders {
			_ = database.Model(&db.User{}).Where("id = ?", folder.UserID).Update(db.ColIsCleaningTrash, true)

			err := database.Where("id = ?", folder.ID).Delete(&db.Folder{}).Error
			if err != nil {
				logger.Error("Failed to permanently delete folder from trash", "folderId", folder.ID, "error", err)
			}

			_ = database.Model(&db.User{}).Where("id = ?", folder.UserID).Update(db.ColIsCleaningTrash, false)
		}
	}

	logger.Info("Trash cleanup cron completed.")
}
