package s3

import (
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"gorm.io/gorm"
)

func (s *S3Controller) ListBuckets(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	var user db.User
	if err := s.database.Where("id = ?", userID).First(&user).Error; err != nil {
		return sendS3Error(c, err)
	}

	buckets, err := s.s3Service.ListBuckets(userID)
	if err != nil {
		return sendS3Error(c, err)
	}

	bucketList := make([]BucketXML, len(buckets))
	for i, b := range buckets {
		bucketList[i] = BucketXML{
			Name:         b.Name,
			CreationDate: formatISO8601(b.CreatedAt),
		}
	}

	displayName := user.Username
	if displayName == "" {
		displayName = userID
	}

	resp := ListAllMyBucketsResult{
		Xmlns: S3XmlNamespace,
		Owner: Owner{
			ID:          userID,
			DisplayName: displayName,
		},
		Buckets: Buckets{
			Bucket: bucketList,
		},
	}

	xmlBytes, err := marshalS3Xml(resp)
	if err != nil {
		return sendS3Error(c, err)
	}

	setRequestId(c)
	return c.Blob(http.StatusOK, "application/xml", xmlBytes)
}

func (s *S3Controller) CreateBucket(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")

	_, err := s.s3Service.CreateBucket(userID, bucket)
	if err != nil {
		return sendS3Error(c, err)
	}

	setRequestId(c)
	c.Response().Header().Set("Location", s.safeBucketLocation(bucket))
	return c.NoContent(http.StatusOK)
}

func (s *S3Controller) HeadBucket(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")

	var folder db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucket).First(&folder).Error
	setRequestId(c)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return c.NoContent(http.StatusNotFound)
		}
		return sendS3Error(c, err)
	}

	return c.NoContent(http.StatusOK)
}

func (s *S3Controller) DeleteBucket(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")

	setRequestId(c)
	err := s.s3Service.DeleteBucket(userID, bucket)
	if err != nil {
		return sendS3Error(c, err)
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *S3Controller) ListObjects(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")

	prefix := c.QueryParam("prefix")
	delimiter := c.QueryParam("delimiter")
	encodingType := c.QueryParam("encoding-type")
	maxKeys := 1000
	if maxKeysStr := c.QueryParam("max-keys"); maxKeysStr != "" {
		if val, err := strconv.Atoi(maxKeysStr); err == nil {
			if val < maxKeys {
				maxKeys = val
			}
		}
	}

	setRequestId(c)
	objects, commonPrefixes, err := s.s3Service.ListObjects(userID, bucket, prefix, delimiter, maxKeys)
	if err != nil {
		return sendS3Error(c, err)
	}

	return s.sendListObjectsResult(c, bucket, prefix, delimiter, encodingType, maxKeys, objects, commonPrefixes)
}

func (s *S3Controller) ListObjectsPublic(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")

	prefix := c.QueryParam("prefix")
	delimiter := c.QueryParam("delimiter")
	encodingType := c.QueryParam("encoding-type")
	maxKeys := 1000
	if maxKeysStr := c.QueryParam("max-keys"); maxKeysStr != "" {
		if val, err := strconv.Atoi(maxKeysStr); err == nil {
			if val < maxKeys {
				maxKeys = val
			}
		}
	}

	setRequestId(c)
	objects, commonPrefixes, err := s.s3Service.ListObjectsPublic(userID, bucket, prefix, delimiter, maxKeys)
	if err != nil {
		return sendS3Error(c, err)
	}

	return s.sendListObjectsResult(c, bucket, prefix, delimiter, encodingType, maxKeys, objects, commonPrefixes)
}

func (s *S3Controller) sendListObjectsResult(
	c echo.Context,
	bucket string,
	prefix string,
	delimiter string,
	encodingType string,
	maxKeys int,
	objects []ObjectInfo,
	commonPrefixes []string,
) error {
	isTruncated := len(objects) >= maxKeys
	keyCount := len(objects) + len(commonPrefixes)

	contentsXML := make([]ObjectContentXML, len(objects))
	for i, o := range objects {
		contentsXML[i] = ObjectContentXML{
			Key:          encodeS3Key(o.Key, encodingType),
			LastModified: formatISO8601(o.LastModified),
			ETag:         o.ETag,
			Size:         o.Size,
			StorageClass: "STANDARD",
		}
	}

	prefixesXML := make([]CommonPrefixXML, len(commonPrefixes))
	for i, p := range commonPrefixes {
		prefixesXML[i] = CommonPrefixXML{
			Prefix: encodeS3Key(p, encodingType),
		}
	}

	resp := ListBucketResult{
		Xmlns:          S3XmlNamespace,
		Name:           bucket,
		Prefix:         encodeS3Key(prefix, encodingType),
		KeyCount:       keyCount,
		MaxKeys:        maxKeys,
		Delimiter:      encodeS3Key(delimiter, encodingType),
		EncodingType:   encodingType,
		IsTruncated:    isTruncated,
		Contents:       contentsXML,
		CommonPrefixes: prefixesXML,
	}

	xmlBytes, err := marshalS3Xml(resp)
	if err != nil {
		return sendS3Error(c, err)
	}

	c.Response().Header().Set("Content-Type", "application/xml")
	return c.Blob(http.StatusOK, "application/xml", xmlBytes)
}

func (s *S3Controller) HandleBucketPost(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")

	setRequestId(c)

	// DeleteObjects API
	if c.QueryParams().Has("delete") {
		var input DeleteInput
		bodyBytes, err := io.ReadAll(c.Request().Body)
		if err != nil {
			return sendS3Error(c, errors.New("InvalidRequest"))
		}

		if err := xml.Unmarshal(bodyBytes, &input); err != nil {
			return sendS3Error(c, errors.New("InvalidRequest"))
		}

		var deleted []DeletedXML
		var deleteErrors []DeleteError

		for _, item := range input.Objects {
			if strings.HasSuffix(item.Key, "/") {
				_, err = s.s3Service.DeleteFolderMarker(userID, bucket, item.Key)
				if err == nil {
					deleted = append(deleted, DeletedXML{Key: item.Key})
				} else {
					deleteErrors = append(deleteErrors, DeleteError{
						Key:     item.Key,
						Code:    "InternalError",
						Message: err.Error(),
					})
				}
				continue
			}

			file, err := s.s3Service.FindObject(userID, bucket, item.Key)
			if err != nil {
				if err.Error() == "NoSuchKey" {
					deleted = append(deleted, DeletedXML{Key: item.Key}) // S3 says: deleting non-existent is a success
				} else {
					deleteErrors = append(deleteErrors, DeleteError{
						Key:     item.Key,
						Code:    "NoSuchKey",
						Message: err.Error(),
					})
				}
				continue
			}

			// Soft delete from lifecycle
			now := time.Now()
			err = s.database.Transaction(func(tx *gorm.DB) error {
				if err := tx.Model(&file).Update(db.ColDeletedAt, &now).Error; err != nil {
					return err
				}
				// Decrement quota
				return tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" - ?", file.Size)).Error
			})

			if err == nil {
				_ = s.s3Service.CleanupEmptyFolders(userID, file.FolderID)
				deleted = append(deleted, DeletedXML{Key: item.Key})
			} else {
				deleteErrors = append(deleteErrors, DeleteError{
					Key:     item.Key,
					Code:    "InternalError",
					Message: err.Error(),
				})
			}
		}

		resp := DeleteResult{
			Xmlns: S3XmlNamespace,
		}
		if !input.Quiet {
			resp.Deleted = deleted
		}
		resp.Errors = deleteErrors

		xmlBytes, err := marshalS3Xml(resp)
		if err != nil {
			return sendS3Error(c, err)
		}

		c.Response().Header().Set("Content-Type", "application/xml")
		return c.Blob(http.StatusOK, "application/xml", xmlBytes)
	}

	return sendS3Error(c, errors.New("InvalidRequest"))
}

func (s *S3Controller) doCopyObject(c echo.Context, userID string, destBucket string, destKey string, copySource string) error {
	cleanSource := copySource
	if strings.HasPrefix(cleanSource, "/") {
		cleanSource = cleanSource[1:]
	}
	slashIdx := strings.Index(cleanSource, "/")
	if slashIdx == -1 {
		return sendS3Error(c, errors.New("InvalidArgument"))
	}

	sourceBucket := cleanSource[:slashIdx]
	sourceKey := cleanSource[slashIdx+1:]

	// S3 allows self-copy (no-op)
	if sourceBucket == destBucket && sourceKey == destKey {
		file, err := s.s3Service.FindObject(userID, sourceBucket, sourceKey)
		if err != nil {
			return sendS3Error(c, err)
		}

		etag := `"` + file.ID + `"`
		if file.Etag != nil {
			etag = *file.Etag
		}

		resp := CopyObjectResult{
			Xmlns:        S3XmlNamespace,
			LastModified: formatISO8601(file.UpdatedAt),
			ETag:         etag,
		}

		xmlBytes, _ := xml.Marshal(resp)
		c.Response().Header().Set("Content-Type", "application/xml")
		c.Response().Header().Set("ETag", etag)
		return c.Blob(http.StatusOK, "application/xml", xmlBytes)
	}

	sourceFile, err := s.s3Service.FindObject(userID, sourceBucket, sourceKey)
	if err != nil {
		return sendS3Error(c, err)
	}

	destFolderID, _, err := s.s3Service.ResolveKey(userID, destBucket, destKey, true)
	if err != nil {
		return sendS3Error(c, err)
	}

	destFilename := destKey
	if lastSlash := strings.LastIndex(destKey, "/"); lastSlash != -1 {
		destFilename = destKey[lastSlash+1:]
	}

	inheritedEtag := `"` + sourceFile.ID + `"`
	if sourceFile.Etag != nil {
		inheritedEtag = *sourceFile.Etag
	}

	// GORM record clone
	newRecord := db.FileRecord{
		ID:                generateUUID(),
		Filename:          destFilename,
		Size:              sourceFile.Size,
		MimeType:          sourceFile.MimeType,
		TelegramFileID:    sourceFile.TelegramFileID,
		TelegramMessageID: sourceFile.TelegramMessageID,
		BotID:             sourceFile.BotID,
		IsChunked:         sourceFile.IsChunked,
		TotalChunks:       sourceFile.TotalChunks,
		Status:            "complete",
		IsEncrypted:       sourceFile.IsEncrypted,
		EncryptionAlgo:    sourceFile.EncryptionAlgo,
		EncryptionIv:      sourceFile.EncryptionIv,
		EncryptedKey:      sourceFile.EncryptedKey,
		Etag:              &inheritedEtag,
		FolderID:          destFolderID,
		UserID:            userID,
		Visibility:        "PRIVATE",
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}

	err = s.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&newRecord).Error; err != nil {
			return err
		}
		return tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" + ?", sourceFile.Size)).Error
	})

	if err != nil {
		return sendS3Error(c, err)
	}

	resp := CopyObjectResult{
		Xmlns:        S3XmlNamespace,
		LastModified: formatISO8601(newRecord.CreatedAt),
		ETag:         inheritedEtag,
	}

	xmlBytes, _ := xml.Marshal(resp)
	c.Response().Header().Set("Content-Type", "application/xml")
	c.Response().Header().Set("ETag", inheritedEtag)
	return c.Blob(http.StatusOK, "application/xml", xmlBytes)
}
