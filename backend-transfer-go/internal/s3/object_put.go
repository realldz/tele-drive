package s3

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"gorm.io/gorm"
)

func (s *S3Controller) HandlePut(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	// S3 CopyObject API
	if copySource := c.Request().Header.Get("x-amz-copy-source"); copySource != "" {
		unescapedSource, err := url.QueryUnescape(copySource)
		if err != nil {
			unescapedSource = copySource
		}
		return s.doCopyObject(c, userID, bucket, key, unescapedSource)
	}

	// S3 UploadPart API
	uploadID := c.QueryParam("uploadId")
	partNumberStr := c.QueryParam("partNumber")
	if uploadID != "" && partNumberStr != "" {
		partNumber, err := strconv.Atoi(partNumberStr)
		if err != nil {
			return sendS3Error(c, errors.New("InvalidArgument"))
		}

		contentLength := int64(0)
		if cl := c.Request().Header.Get("Content-Length"); cl != "" {
			if val, err := strconv.ParseInt(cl, 10, 64); err == nil {
				contentLength = val
			}
		}

		etag, _, err := s.s3Multipart.UploadPart(c.Request().Context(), uploadID, partNumber, userID, c.Request().Body, contentLength)
		if err != nil {
			return sendS3Error(c, err)
		}

		c.Response().Header().Set("ETag", etag)
		return c.NoContent(http.StatusOK)
	}

	// Standard PutObject API
	contentLength := int64(0)
	if cl := c.Request().Header.Get("Content-Length"); cl != "" {
		if val, err := strconv.ParseInt(cl, 10, 64); err == nil {
			contentLength = val
		}
	}

	return s.doPutObject(c, userID, bucket, key, contentLength)
}

func (s *S3Controller) doPutObject(c echo.Context, userID string, bucket string, key string, contentLength int64) error {
	contentType := c.Request().Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	contentMd5Header := c.Request().Header.Get("Content-MD5")
	filename := key
	if lastSlash := strings.LastIndex(key, "/"); lastSlash != -1 {
		filename = key[lastSlash+1:]
	}

	if contentLength == 0 {
		folderKey := key
		if !strings.HasSuffix(folderKey, "/") {
			folderKey = folderKey + "/"
		}
		_, err := s.s3Service.ResolveKeyAsFolder(userID, bucket, folderKey)
		if err != nil {
			return sendS3Error(c, err)
		}
		return c.NoContent(http.StatusOK)
	}

	folderID, _, err := s.s3Service.ResolveKey(userID, bucket, key, true)
	if err != nil {
		return sendS3Error(c, err)
	}

	existingFiles, err := s.s3Service.FindObjectRecords(userID, bucket, key)
	if err != nil {
		return sendS3Error(c, err)
	}

	// 1. Check user quota
	var user db.User
	if err := s.database.Where("id = ?", userID).First(&user).Error; err != nil {
		return sendS3Error(c, err)
	}
	if user.UsedSpace+contentLength > user.Quota {
		return sendS3Error(c, errors.New("QuotaExceeded"))
	}

	capacityOk := s.s3Multipart.shouldBuffer(contentLength)

	if capacityOk {
		storageKey := fmt.Sprintf("buf/%s.tmp", generateUUID())
		hash := md5.New()
		counter := &countingWriter{w: hash}
		tee := io.TeeReader(c.Request().Body, counter)

		_, err = s.tempStorage.Write(storageKey, tee)
		if err == nil {
			md5Hex := hex.EncodeToString(hash.Sum(nil))
			etag := fmt.Sprintf("\"%s\"", md5Hex)

			// Content-MD5 verification
			if contentMd5Header != "" {
				expectedMd5HexBytes, _ := base64.StdEncoding.DecodeString(contentMd5Header)
				expectedMd5Hex := hex.EncodeToString(expectedMd5HexBytes)
				if expectedMd5Hex != md5Hex {
					_ = s.tempStorage.Delete(storageKey)
					return sendS3Error(c, errors.New("BadDigest"))
				}
			}

			record := db.FileRecord{
				ID:             generateUUID(),
				Filename:       filename,
				Size:           contentLength,
				MimeType:       contentType,
				Status:         "buffered",
				TempStorageKey: &storageKey,
				IsChunked:      false,
				TotalChunks:    1,
				FolderID:       folderID,
				UserID:         userID,
				Etag:           &etag,
				CreatedAt:      time.Now(),
				UpdatedAt:      time.Now(),
			}

			if err := s.database.Create(&record).Error; err == nil {
				// Soft delete existing files
				if len(existingFiles) > 0 {
					var ids []string
					for _, f := range existingFiles {
						ids = append(ids, f.ID)
					}
					now := time.Now()
					_ = s.database.Model(&db.FileRecord{}).Where("id IN ?", ids).Update(db.ColDeletedAt, &now).Error
				}

				// Enqueue upload job
				jobData := map[string]interface{}{
					"type":           "file",
					"recordId":       record.ID,
					"tempStorageKey": storageKey,
					"userId":         userID,
				}
				maxRetries := s.settingsCache.GetCachedSettingInt("BUFFER_MAX_RETRIES", 3)
				_ = s.bullClient.AddJob(c.Request().Context(), "upload-dispatch", "dispatch-file", fmt.Sprintf("file-%s", record.ID), jobData, maxRetries)

				c.Response().Header().Set("ETag", etag)
				return c.NoContent(http.StatusOK)
			}
			_ = s.tempStorage.Delete(storageKey)
		}
	}

	// Direct upload fallback
	dek, err := s.cryptoEngine.GenerateFileKey()
	if err != nil {
		return sendS3Error(c, err)
	}

	iv, err := s.cryptoEngine.GenerateIv()
	if err != nil {
		return sendS3Error(c, err)
	}

	encryptedKey, err := s.cryptoEngine.EncryptKey(dek)
	if err != nil {
		return sendS3Error(c, err)
	}

	record := db.FileRecord{
		ID:             generateUUID(),
		Filename:       filename,
		Size:           contentLength,
		MimeType:       contentType,
		IsChunked:      false,
		TotalChunks:    1,
		Status:         "uploading",
		IsEncrypted:    true,
		EncryptionAlgo: stringAddr("aes-256-ctr"),
		EncryptionIv:   stringAddr(hex.EncodeToString(iv)),
		EncryptedKey:   &encryptedKey,
		FolderID:       folderID,
		UserID:         userID,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := s.database.Create(&record).Error; err != nil {
		return sendS3Error(c, err)
	}

	hash := md5.New()
	counter := &countingWriter{w: hash}
	tee := io.TeeReader(c.Request().Body, counter)

	encryptedStream, err := s.cryptoEngine.EncryptStream(tee, dek, iv)
	if err != nil {
		_ = s.database.Delete(&record)
		return sendS3Error(c, err)
	}

	telegramFileID, telegramMessageID, botID, err := s.telegram.UploadFile(c.Request().Context(), encryptedStream, filename, contentLength)
	if err != nil {
		_ = s.database.Delete(&record)
		return sendS3Error(c, err)
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)

	// Content-MD5 verification for direct upload
	if contentMd5Header != "" {
		expectedMd5HexBytes, _ := base64.StdEncoding.DecodeString(contentMd5Header)
		expectedMd5Hex := hex.EncodeToString(expectedMd5HexBytes)
		if expectedMd5Hex != md5Hex {
			_ = s.database.Delete(&record)
			_ = s.telegram.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
			return sendS3Error(c, errors.New("BadDigest"))
		}
	}

	err = s.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&record).Updates(map[string]interface{}{
			"telegramFileId":    telegramFileID,
			"telegramMessageId": telegramMessageID,
			"botId":             botID,
			"status":            "complete",
			"etag":              etag,
		}).Error; err != nil {
			return err
		}

		if err := tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" + ?", contentLength)).Error; err != nil {
			return err
		}

		if len(existingFiles) > 0 {
			var ids []string
			for _, f := range existingFiles {
				ids = append(ids, f.ID)
			}
			now := time.Now()
			if err := tx.Model(&db.FileRecord{}).Where("id IN ?", ids).Update(db.ColDeletedAt, &now).Error; err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		_ = s.telegram.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
		return sendS3Error(c, err)
	}

	c.Response().Header().Set("ETag", etag)
	return c.NoContent(http.StatusOK)
}
