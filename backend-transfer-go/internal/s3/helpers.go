package s3

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
)

func S3AuthMiddleware(authenticator *S3Authenticator) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			userID, err := authenticator.Authenticate(c)
			if err != nil {
				return sendS3Error(c, errors.New("AccessDenied"))
			}
			c.Set("s3UserId", userID)
			return next(c)
		}
	}
}

func S3PublicMiddleware(database *db.DB, settings *db.SettingsCache) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			userID := c.Param("userId")
			bucket := c.Param("bucket")

			if userID == "" || bucket == "" {
				return sendS3Error(c, errors.New("AccessDenied"))
			}

			enabled := settings.GetCachedSettingBool("S3_PUBLIC_ACCESS_ENABLED", true)
			if !enabled {
				return sendS3Error(c, errors.New("AccessDenied"))
			}

			var folder db.Folder
			err := database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"s3PublicAccess\" = ? AND \"deletedAt\" IS NULL", userID, bucket, true).First(&folder).Error
			if err != nil {
				return sendS3Error(c, errors.New("AccessDenied"))
			}

			c.Set("s3UserId", userID)
			c.Set("s3PublicAccess", true)
			return next(c)
		}
	}
}

func getObjectKey(c echo.Context, bucket string) string {
	path := c.Request().URL.Path
	prefix1 := fmt.Sprintf("/s3/%s/", bucket)
	if strings.HasPrefix(path, prefix1) {
		key := path[len(prefix1):]
		if decoded, err := url.PathUnescape(key); err == nil {
			return decoded
		}
		return key
	}
	prefix2 := fmt.Sprintf("/api/s3/%s/", bucket)
	if strings.HasPrefix(path, prefix2) {
		key := path[len(prefix2):]
		if decoded, err := url.PathUnescape(key); err == nil {
			return decoded
		}
		return key
	}

	// For public
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		if segment == bucket && i > 1 && segments[i-1] != "" {
			key := strings.Join(segments[i+1:], "/")
			if decoded, err := url.PathUnescape(key); err == nil {
				return decoded
			}
			return key
		}
	}

	key := c.Param("*")
	if decoded, err := url.PathUnescape(key); err == nil {
		return decoded
	}
	return key
}

func sendS3Error(c echo.Context, err error) error {
	msg := err.Error()
	status := http.StatusInternalServerError

	code := "InternalError"
	message := msg

	switch msg {
	case "NoSuchBucket":
		status = http.StatusNotFound
		code = "NoSuchBucket"
		message = "The specified bucket does not exist."
	case "NoSuchKey":
		status = http.StatusNotFound
		code = "NoSuchKey"
		message = "The specified key does not exist."
	case "BucketNotEmpty":
		status = http.StatusConflict
		code = "BucketNotEmpty"
		message = "The bucket you tried to delete is not empty."
	case "InvalidArgument":
		status = http.StatusBadRequest
		code = "InvalidArgument"
		message = "Invalid Argument"
	case "BadDigest":
		status = http.StatusBadRequest
		code = "BadDigest"
		message = "The Content-MD5 you specified did not match what we received."
	case "AccessDenied":
		status = http.StatusForbidden
		code = "AccessDenied"
		message = "Access Denied"
	case "InvalidRequest":
		status = http.StatusBadRequest
		code = "InvalidRequest"
		message = "Invalid Request"
	case "QuotaExceeded":
		status = http.StatusBadRequest
		code = "QuotaExceeded"
		message = "Your storage quota has been exceeded."
	case "ServiceUnavailable":
		status = http.StatusServiceUnavailable
		code = "ServiceUnavailable"
		message = "A temporary upstream error occurred. Please retry."
	default:
		if strings.Contains(msg, "access key not found") {
			status = http.StatusForbidden
			code = "AccessDenied"
			message = "Access Denied"
		}
	}

	resp := S3ErrorResponse{
		Code:    code,
		Message: message,
	}

	xmlBytes, errMarshal := marshalS3Xml(resp)
	if errMarshal != nil {
		return c.String(http.StatusInternalServerError, "Internal Server Error")
	}

	c.Response().Header().Set("Content-Type", "application/xml")
	c.Response().Header().Set("x-amz-request-id", generateRequestId())
	return c.Blob(status, "application/xml", xmlBytes)
}

func setRequestId(c echo.Context) {
	c.Response().Header().Set("x-amz-request-id", generateRequestId())
	c.Response().Header().Set("x-amz-id-2", generateId2())
}

func generateRequestId() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func generateId2() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

func (s *S3Controller) safeBucketLocation(bucket string) string {
	trimmed := strings.Trim(bucket, "/\\ ")
	if trimmed == "" {
		return "/"
	}
	return "/" + trimmed
}
