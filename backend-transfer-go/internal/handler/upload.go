package handler

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"gorm.io/gorm"
)

func (h *FileHandler) Upload(c echo.Context) error {
	userID := c.Get("userId").(string)

	file, err := c.FormFile("file")
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "No file field in request"})
	}

	folderID := c.FormValue("folderId")
	var folderIDPtr *string
	if folderID != "" {
		folderIDPtr = &folderID
	}

	onConflict := c.QueryParam("onConflict") // "overwrite" | "rename" | "skip"

	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	size := file.Size

	// Quota check
	var user db.User
	if err := h.database.Where("id = ?", userID).First(&user).Error; err != nil {
		return err
	}
	if user.UsedSpace+size > user.Quota {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Storage quota exceeded."})
	}

	// Conflict resolution
	targetFilename := file.Filename
	var existingNames []string
	h.database.Model(&db.FileRecord{}).Where("\"folderId\" = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", folderIDPtr, userID).Pluck("filename", &existingNames)
	var existingFolders []string
	h.database.Model(&db.Folder{}).Where("\"parentId\" = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", folderIDPtr, userID).Pluck("name", &existingFolders)
	allNames := append(existingNames, existingFolders...)

	hasConflict := false
	var conflictFile db.FileRecord
	errConflict := h.database.Where("\"folderId\" = ? AND filename = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", folderIDPtr, file.Filename, userID).First(&conflictFile).Error
	if errConflict == nil {
		hasConflict = true
	}

	if hasConflict {
		if onConflict == "" || onConflict == "skip" {
			suggestedName := GenerateUniqueName(file.Filename, allNames)
			return c.JSON(http.StatusConflict, map[string]interface{}{
				"message":       "A file or folder with this name already exists in the destination folder",
				"type":          "file",
				"id":            conflictFile.ID,
				"name":          conflictFile.Filename,
				"suggestedName": suggestedName,
			})
		} else if onConflict == "overwrite" {
			now := time.Now()
			h.database.Model(&conflictFile).Update(db.ColDeletedAt, &now)
			h.database.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" - ?", conflictFile.Size))
		} else if onConflict == "rename" {
			targetFilename = GenerateUniqueName(file.Filename, allNames)
		}
	}

	// Buffering check
	capacityOk := false
	maxSize := h.settingsCache.GetCachedSettingInt64("MAX_BUFFER_FILE_SIZE", 52428800)
	if size <= maxSize {
		usedBytes, err := h.tempStorage.GetUsedBytes()
		if err == nil {
			maxDiskMb := h.settingsCache.GetCachedSettingInt64("MAX_BUFFER_DISK_MB", 2048)
			maxBytes := maxDiskMb * 1024 * 1024
			threshold := int64(float64(maxBytes) * 0.8)
			if usedBytes < threshold {
				capacityOk = true
			}
		}
	}

	if capacityOk {
		storageKey := fmt.Sprintf("buf/%s.tmp", generateUUID())
		hash := md5.New()
		counter := &countingWriter{w: hash}
		tee := io.TeeReader(src, counter)

		_, err = h.tempStorage.Write(storageKey, tee)
		if err == nil {
			md5Hex := hex.EncodeToString(hash.Sum(nil))
			etag := fmt.Sprintf("\"%s\"", md5Hex)

			record := db.FileRecord{
				ID:             generateUUID(),
				Filename:       targetFilename,
				Size:           size,
				MimeType:       file.Header.Get("Content-Type"),
				Status:         "buffered",
				TempStorageKey: &storageKey,
				IsChunked:      false,
				TotalChunks:    1,
				FolderID:       folderIDPtr,
				UserID:         userID,
				Etag:           &etag,
				CreatedAt:      time.Now(),
				UpdatedAt:      time.Now(),
			}

			if err := h.database.Create(&record).Error; err == nil {
				jobData := map[string]interface{}{
					"type":           "file",
					"recordId":       record.ID,
					"tempStorageKey": storageKey,
					"userId":         userID,
				}
				maxRetries := h.settingsCache.GetCachedSettingInt("BUFFER_MAX_RETRIES", 3)
				_ = h.bullClient.AddJob(c.Request().Context(), "upload-dispatch", "dispatch-file", fmt.Sprintf("file-%s", record.ID), jobData, maxRetries)

				return c.JSON(http.StatusOK, record)
			}
			_ = h.tempStorage.Delete(storageKey)
		}
	}

	// Direct upload path
	dek, err := h.cryptoEngine.GenerateFileKey()
	if err != nil {
		return err
	}
	iv, err := h.cryptoEngine.GenerateIv()
	if err != nil {
		return err
	}
	encryptedKey, err := h.cryptoEngine.EncryptKey(dek)
	if err != nil {
		return err
	}

	record := db.FileRecord{
		ID:             generateUUID(),
		Filename:       targetFilename,
		Size:           size,
		MimeType:       file.Header.Get("Content-Type"),
		IsChunked:      false,
		TotalChunks:    1,
		Status:         "uploading",
		IsEncrypted:    true,
		EncryptionAlgo: stringAddr("aes-256-ctr"),
		EncryptionIv:   stringAddr(hex.EncodeToString(iv)),
		EncryptedKey:   &encryptedKey,
		FolderID:       folderIDPtr,
		UserID:         userID,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := h.database.Create(&record).Error; err != nil {
		return err
	}

	hash := md5.New()
	counter := &countingWriter{w: hash}
	tee := io.TeeReader(src, counter)
	encryptedStream, err := h.cryptoEngine.EncryptStream(tee, dek, iv)
	if err != nil {
		h.database.Delete(&record)
		return err
	}

	telegramFileID, telegramMessageID, botID, err := h.telegramClient.UploadFile(c.Request().Context(), encryptedStream, targetFilename, size)
	if err != nil {
		h.database.Delete(&record)
		return err
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)

	err = h.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&record).Updates(map[string]interface{}{
			"telegramFileId":    telegramFileID,
			"telegramMessageId": telegramMessageID,
			"botId":             botID,
			"status":            "complete",
			"etag":              etag,
		}).Error; err != nil {
			return err
		}

		return tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" + ?", size)).Error
	})

	if err != nil {
		_ = h.telegramClient.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
		return err
	}

	return c.JSON(http.StatusOK, record)
}

func (h *FileHandler) InitUpload(c echo.Context) error {
	userID := c.Get("userId").(string)

	type inputDTO struct {
		Filename    string  `json:"filename"`
		Size        int64   `json:"size"`
		MimeType    string  `json:"mimeType"`
		TotalChunks int     `json:"totalChunks"`
		FolderID    *string `json:"folderId"`
	}

	var input inputDTO
	if err := c.Bind(&input); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request payload"})
	}

	if input.Filename == "" || input.Size <= 0 || input.TotalChunks <= 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid filename, size, or totalChunks"})
	}

	// Quota check
	var user db.User
	if err := h.database.Where("id = ?", userID).First(&user).Error; err != nil {
		return err
	}
	if user.UsedSpace+input.Size > user.Quota {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Storage quota exceeded."})
	}

	// Conflict check
	var existingNames []string
	h.database.Model(&db.FileRecord{}).Where("\"folderId\" = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", input.FolderID, userID).Pluck("filename", &existingNames)
	var existingFolders []string
	h.database.Model(&db.Folder{}).Where("\"parentId\" = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", input.FolderID, userID).Pluck("name", &existingFolders)
	allNames := append(existingNames, existingFolders...)

	targetFilename := input.Filename
	onConflict := c.QueryParam("onConflict")

	var conflictFile db.FileRecord
	errConflict := h.database.Where("\"folderId\" = ? AND filename = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", input.FolderID, input.Filename, userID).First(&conflictFile).Error
	if errConflict == nil {
		if onConflict == "" || onConflict == "skip" {
			suggestedName := GenerateUniqueName(input.Filename, allNames)
			return c.JSON(http.StatusConflict, map[string]interface{}{
				"message":       "A file or folder with this name already exists in the destination folder",
				"type":          "file",
				"id":            conflictFile.ID,
				"name":          conflictFile.Filename,
				"suggestedName": suggestedName,
			})
		} else if onConflict == "overwrite" {
			now := time.Now()
			h.database.Model(&conflictFile).Update(db.ColDeletedAt, &now)
			h.database.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" - ?", conflictFile.Size))
		} else if onConflict == "rename" {
			targetFilename = GenerateUniqueName(input.Filename, allNames)
		}
	}

	dek, err := h.cryptoEngine.GenerateFileKey()
	if err != nil {
		return err
	}
	iv, err := h.cryptoEngine.GenerateIv()
	if err != nil {
		return err
	}
	encryptedKey, err := h.cryptoEngine.EncryptKey(dek)
	if err != nil {
		return err
	}

	record := db.FileRecord{
		ID:             generateUUID(),
		Filename:       targetFilename,
		Size:           input.Size,
		MimeType:       input.MimeType,
		IsChunked:      true,
		TotalChunks:    input.TotalChunks,
		Status:         "uploading",
		IsEncrypted:    true,
		EncryptionAlgo: stringAddr("aes-256-ctr"),
		EncryptionIv:   stringAddr(hex.EncodeToString(iv)),
		EncryptedKey:   &encryptedKey,
		FolderID:       input.FolderID,
		UserID:         userID,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := h.database.Create(&record).Error; err != nil {
		return err
	}

	return c.JSON(http.StatusOK, record)
}

func (h *FileHandler) CompleteUpload(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	var fileRecord db.FileRecord
	err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).Preload("Chunks").First(&fileRecord).Error
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}

	if fileRecord.Status == "complete" {
		return c.JSON(http.StatusOK, fileRecord)
	}

	var chunks []db.FileChunk
	if err := h.database.Where("\"fileId\" = ?", fileID).Order("\"chunkIndex\" ASC").Find(&chunks).Error; err != nil {
		return err
	}

	if len(chunks) < fileRecord.TotalChunks {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": fmt.Sprintf("Missing chunks: uploaded %d/%d", len(chunks), fileRecord.TotalChunks)})
	}

	var totalSize int64
	var partMd5Bytes []byte
	for _, c := range chunks {
		totalSize += int64(c.Size)
		hexMd5 := ""
		if c.Etag != nil {
			hexMd5 = strings.ReplaceAll(*c.Etag, "\"", "")
		}

		if len(hexMd5) != 32 {
			h := md5.New()
			h.Write([]byte(fmt.Sprintf("%d", c.ChunkIndex)))
			partMd5Bytes = append(partMd5Bytes, h.Sum(nil)...)
		} else {
			rawBytes, _ := hex.DecodeString(hexMd5)
			partMd5Bytes = append(partMd5Bytes, rawBytes...)
		}
	}

	concatMd5 := md5.Sum(partMd5Bytes)
	finalEtag := fmt.Sprintf("\"%s-%d\"", hex.EncodeToString(concatMd5[:]), len(chunks))

	// Find conflicts for overwrite soft deletes
	var existingFiles []db.FileRecord
	h.database.Where("\"folderId\" = ? AND filename = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", fileRecord.FolderID, fileRecord.Filename, userID).Find(&existingFiles)

	var replacedRecordIDs []string
	for _, rec := range existingFiles {
		if rec.ID != fileID {
			replacedRecordIDs = append(replacedRecordIDs, rec.ID)
		}
	}

	err = h.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&db.FileRecord{}).Where("id = ?", fileID).Updates(map[string]interface{}{
			"status":      "complete",
			"totalChunks": len(chunks),
			"size":        totalSize,
			"etag":        finalEtag,
			"updatedAt":   time.Now(),
		}).Error; err != nil {
			return err
		}

		if err := tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" + ?", totalSize)).Error; err != nil {
			return err
		}

		if len(replacedRecordIDs) > 0 {
			now := time.Now()
			if err := tx.Model(&db.FileRecord{}).Where("id IN ?", replacedRecordIDs).Update(db.ColDeletedAt, &now).Error; err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		return err
	}

	// Fetch final record
	h.database.Where("id = ?", fileID).First(&fileRecord)
	return c.JSON(http.StatusOK, fileRecord)
}

func (h *FileHandler) AbortUpload(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	var fileRecord db.FileRecord
	err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).First(&fileRecord).Error
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}

	if fileRecord.Status == "complete" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Cannot abort a completed upload. Use DELETE instead."})
	}

	h.database.Model(&fileRecord).Update("status", "aborted")

	var chunks []db.FileChunk
	if err := h.database.Where("\"fileId\" = ?", fileID).Find(&chunks).Error; err == nil {
		for _, chunk := range chunks {
			if chunk.TelegramMessageID != nil {
				_ = h.telegramClient.DeleteMessage(c.Request().Context(), *chunk.TelegramMessageID, chunk.BotID)
			}
		}
	}

	err = h.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("\"fileId\" = ?", fileID).Delete(&db.FileChunk{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", fileID).Delete(&db.FileRecord{}).Error
	})

	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func (h *FileHandler) GetUploadStatus(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}

	var chunks []db.FileChunk
	h.database.Where("\"fileId\" = ?", fileID).Order("\"chunkIndex\" ASC").Find(&chunks)

	type chunkStatus struct {
		ChunkIndex int  `json:"chunkIndex"`
		Uploaded   bool `json:"uploaded"`
	}
	var results []chunkStatus
	for _, c := range chunks {
		results = append(results, chunkStatus{
			ChunkIndex: c.ChunkIndex,
			Uploaded:   c.TelegramFileID != nil && *c.TelegramFileID != "",
		})
	}

	return c.JSON(http.StatusOK, results)
}
