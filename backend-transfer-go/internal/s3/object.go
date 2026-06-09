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

func (s *S3Controller) HandlePost(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	// 1. CreateMultipartUpload API
	if c.QueryParams().Has("uploads") {
		contentType := c.Request().Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		uploadID, err := s.s3Multipart.CreateMultipartUpload(c.Request().Context(), userID, bucket, key, contentType)
		if err != nil {
			return sendS3Error(c, err)
		}

		resp := InitiateMultipartUploadResult{
			Xmlns:    S3XmlNamespace,
			Bucket:   bucket,
			Key:      key,
			UploadId: uploadID,
		}

		xmlBytes, _ := xml.Marshal(resp)
		c.Response().Header().Set("Content-Type", "application/xml")
		return c.Blob(http.StatusOK, "application/xml", xmlBytes)
	}

	// 2. CompleteMultipartUpload API
	if uploadID := c.QueryParam("uploadId"); uploadID != "" {
		bodyBytes, err := io.ReadAll(c.Request().Body)
		if err != nil {
			return sendS3Error(c, errors.New("InvalidRequest"))
		}

		var input CompleteMultipartUploadInput
		if err := xml.Unmarshal(bodyBytes, &input); err != nil {
			return sendS3Error(c, errors.New("InvalidRequest"))
		}

		location, etag, err := s.s3Multipart.CompleteMultipartUpload(c.Request().Context(), uploadID, userID, bucket, key, len(input.Parts))
		if err != nil {
			return sendS3Error(c, err)
		}

		resp := CompleteMultipartUploadResult{
			Xmlns:    S3XmlNamespace,
			Location: location,
			Bucket:   bucket,
			Key:      key,
			ETag:     etag,
		}

		xmlBytes, _ := xml.Marshal(resp)
		c.Response().Header().Set("Content-Type", "application/xml")
		c.Response().Header().Set("ETag", etag)
		return c.Blob(http.StatusOK, "application/xml", xmlBytes)
	}

	return sendS3Error(c, errors.New("InvalidRequest"))
}

func (s *S3Controller) HandleGet(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	// ListParts API
	if uploadID := c.QueryParam("uploadId"); uploadID != "" {
		parts, err := s.s3Multipart.ListParts(c.Request().Context(), uploadID, userID)
		if err != nil {
			return sendS3Error(c, err)
		}

		partsXML := make([]ListPartXML, len(parts))
		for i, p := range parts {
			partsXML[i] = ListPartXML{
				PartNumber: p.PartNumber,
				Size:       p.Size,
				ETag:       p.ETag,
			}
		}

		resp := ListPartsResult{
			Xmlns:       S3XmlNamespace,
			Bucket:      bucket,
			Key:         key,
			UploadId:    uploadID,
			IsTruncated: false,
			Parts:       partsXML,
		}

		xmlBytes, _ := xml.Marshal(resp)
		c.Response().Header().Set("Content-Type", "application/xml")
		return c.Blob(http.StatusOK, "application/xml", xmlBytes)
	}

	// GetObject API
	file, err := s.s3Service.FindObject(userID, bucket, key)
	if err != nil {
		return sendS3Error(c, err)
	}

	info, err := s.downloader.GetDownloadInfo(file)
	if err != nil {
		return sendS3Error(c, err)
	}

	rangeHeader := c.Request().Header.Get("Range")
	return s.downloader.ServeDownload(c, info, rangeHeader, "attachment")
}

func (s *S3Controller) HandleGetPublic(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	file, err := s.s3Service.FindObjectPublic(userID, bucket, key)
	if err != nil {
		return sendS3Error(c, err)
	}

	info, err := s.downloader.GetDownloadInfo(file)
	if err != nil {
		return sendS3Error(c, err)
	}

	rangeHeader := c.Request().Header.Get("Range")
	return s.downloader.ServeDownload(c, info, rangeHeader, "attachment")
}

func (s *S3Controller) HeadObject(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	file, err := s.s3Service.FindObject(userID, bucket, key)
	if err != nil {
		return sendS3Error(c, err)
	}

	etag := `"` + file.ID + `"`
	if file.Etag != nil {
		etag = *file.Etag
	}

	c.Response().Header().Set("Content-Type", file.MimeType)
	c.Response().Header().Set("Content-Length", strconv.FormatInt(file.Size, 10))
	c.Response().Header().Set("ETag", etag)
	c.Response().Header().Set("Last-Modified", file.CreatedAt.UTC().Format(time.RFC1123))
	c.Response().Header().Set("Accept-Ranges", "bytes")

	return c.NoContent(http.StatusOK)
}

func (s *S3Controller) HeadObjectPublic(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	file, err := s.s3Service.FindObjectPublic(userID, bucket, key)
	if err != nil {
		return sendS3Error(c, err)
	}

	etag := `"` + file.ID + `"`
	if file.Etag != nil {
		etag = *file.Etag
	}

	c.Response().Header().Set("Content-Type", file.MimeType)
	c.Response().Header().Set("Content-Length", strconv.FormatInt(file.Size, 10))
	c.Response().Header().Set("ETag", etag)
	c.Response().Header().Set("Last-Modified", file.CreatedAt.UTC().Format(time.RFC1123))
	c.Response().Header().Set("Accept-Ranges", "bytes")

	return c.NoContent(http.StatusOK)
}

func (s *S3Controller) HandleDelete(c echo.Context) error {
	userID := c.Get("s3UserId").(string)
	bucket := c.Param("bucket")
	key := getObjectKey(c, bucket)

	setRequestId(c)

	// AbortMultipartUpload API
	if uploadID := c.QueryParam("uploadId"); uploadID != "" {
		err := s.s3Multipart.AbortMultipartUpload(c.Request().Context(), uploadID, userID)
		if err != nil {
			return sendS3Error(c, err)
		}
		return c.NoContent(http.StatusNoContent)
	}

	// DeleteObject API
	if strings.HasSuffix(key, "/") {
		_, err := s.s3Service.DeleteFolderMarker(userID, bucket, key)
		if err != nil {
			return sendS3Error(c, err)
		}
		return c.NoContent(http.StatusNoContent)
	}

	file, err := s.s3Service.FindObject(userID, bucket, key)
	if err != nil {
		if err.Error() == "NoSuchKey" {
			return c.NoContent(http.StatusNoContent) // S3 spec: delete non-existent key is success
		}
		return sendS3Error(c, err)
	}

	now := time.Now()
	err = s.database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&file).Update(db.ColDeletedAt, &now).Error; err != nil {
			return err
		}
		return tx.Model(&db.User{}).Where("id = ?", userID).Update(db.ColUsedSpace, gorm.Expr("\"usedSpace\" - ?", file.Size)).Error
	})

	if err != nil {
		return sendS3Error(c, err)
	}

	_ = s.s3Service.CleanupEmptyFolders(userID, file.FolderID)
	return c.NoContent(http.StatusNoContent)
}
