package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
)

func (h *FileHandler) GetCachedMetadata(ctx context.Context, fileID string) (*pb.FileMetadata, error) {
	// Try Redis first
	cacheKey := "file:" + fileID
	if data, err := h.redisClient.Get(ctx, cacheKey).Result(); err == nil {
		var meta pb.FileMetadata
		if err := json.Unmarshal([]byte(data), &meta); err == nil {
			return &meta, nil
		}
	}

	// Cache miss -> gRPC
	meta, err := h.grpcClient.GetFileMetadata(ctx, fileID)
	if err != nil {
		return nil, err
	}

	// Repopulate cache
	metaJSON, _ := json.Marshal(meta)
	h.redisClient.Set(ctx, cacheKey, metaJSON, time.Hour)

	return meta, nil
}

func (h *FileHandler) GenerateDownloadToken(c echo.Context) error {
	userID := c.Get("userId").(string)
	id := c.Param("id")

	meta, err := h.GetCachedMetadata(c.Request().Context(), id)
	if err != nil || meta.UserId != userID || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	// settingsCache can be stubbed or configured via environment, default to 300s
	ttl := int64(300)
	token, err := h.cryptoEngine.CreateSignedToken(id, "u", ttl, userID)
	if err != nil {
		return err
	}

	expiresAt := formatISO8601(time.Now().Add(time.Duration(ttl) * time.Second))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"url":       fmt.Sprintf("/files/d/%s", token),
		"expiresAt": expiresAt,
	})
}

func (h *FileHandler) GenerateShareDownloadToken(c echo.Context) error {
	token := c.Param("token")

	meta, err := h.GetCachedMetadata(c.Request().Context(), token)
	if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Shared file not found"})
	}

	ttl := int64(300)
	signedToken, err := h.cryptoEngine.CreateSignedToken(meta.Id, "s", ttl, "")
	if err != nil {
		return err
	}

	expiresAt := formatISO8601(time.Now().Add(time.Duration(ttl) * time.Second))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"url":       fmt.Sprintf("/files/d/%s", signedToken),
		"expiresAt": expiresAt,
	})
}

func (h *FileHandler) DownloadBySigned(c echo.Context) error {
	token := c.Param("token")
	ctx := c.Request().Context()

	// Try Redis one-time token first (S3 redirect flow)
	tokenKey := "token:" + token
	tokenDataStr, err := h.redisClient.Get(ctx, tokenKey).Result()
	if err == nil {
		var tokenData struct {
			FileID string `json:"fileId"`
			UserID string `json:"userId"`
			Type   string `json:"type"`
		}
		if err := json.Unmarshal([]byte(tokenDataStr), &tokenData); err != nil || tokenData.Type != "download" {
			return c.JSON(http.StatusForbidden, map[string]string{"message": "Invalid token format"})
		}

		// Consume token (single-use)
		h.redisClient.Del(ctx, tokenKey)

		meta, err := h.GetCachedMetadata(ctx, tokenData.FileID)
		if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
		}

		return h.downloader.ServeStream(c.Response(), c.Request(), meta)
	}

	// Fallback: crypto-signed token (existing signed URL flow)
	payload, err := h.cryptoEngine.VerifySignedToken(token)
	if err != nil {
		return c.JSON(http.StatusGone, map[string]string{"message": "Invalid or expired download link"})
	}

	meta, err := h.GetCachedMetadata(ctx, payload.FID)
	if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	info, err := h.downloader.GetDownloadInfo(meta)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "attachment")
}

func (h *FileHandler) CheckSignedToken(c echo.Context) error {
	token := c.Param("token")
	_, err := h.cryptoEngine.VerifySignedToken(token)
	if err != nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Invalid or expired download link"})
	}
	return c.NoContent(http.StatusOK)
}

func (h *FileHandler) IssueStreamCookie(c echo.Context) error {
	userID := c.Get("userId").(string)
	ttl := int64(3600)
	token, err := h.cryptoEngine.CreateStreamCookieToken(userID, ttl)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     "stream_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(ttl),
	}
	c.SetCookie(cookie)

	expiresAt := formatISO8601(time.Now().Add(time.Duration(ttl) * time.Second))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"expiresAt": expiresAt,
		"ttl":       ttl,
	})
}

func (h *FileHandler) IssueGuestStreamCookie(c echo.Context) error {
	subject := "guest:" + c.RealIP()
	if uID := c.Get("userId"); uID != nil && uID.(string) != "" {
		subject = uID.(string)
	}

	ttl := int64(3600)
	token, err := h.cryptoEngine.CreateStreamCookieToken(subject, ttl)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     "stream_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(ttl),
	}
	c.SetCookie(cookie)

	expiresAt := formatISO8601(time.Now().Add(time.Duration(ttl) * time.Second))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"expiresAt": expiresAt,
		"ttl":       ttl,
	})
}

func (h *FileHandler) ClearStreamCookie(c echo.Context) error {
	cookie := &http.Cookie{
		Name:     "stream_token",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	}
	c.SetCookie(cookie)
	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func (h *FileHandler) StreamByCookie(c echo.Context) error {
	sub := c.Get("streamUserSubject").(string)
	id := c.Param("id")

	meta, err := h.GetCachedMetadata(c.Request().Context(), id)
	if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	if strings.HasPrefix(sub, "guest:") {
		// Public link check
		if meta.Visibility != "PUBLIC_LINK" {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
		}
	} else {
		// Owner check
		if meta.UserId != sub {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
		}
	}

	info, err := h.downloader.GetDownloadInfo(meta)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "inline")
}

func (h *FileHandler) StreamSharedByCookie(c echo.Context) error {
	shareToken := c.Param("shareToken")

	meta, err := h.GetCachedMetadata(c.Request().Context(), shareToken)
	if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Shared file not found"})
	}

	info, err := h.downloader.GetDownloadInfo(meta)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "inline")
}

func (h *FileHandler) DownloadSharedFile(c echo.Context) error {
	token := c.Param("token")
	fileID := c.Param("fileId")

	// Call NestJS Core to verify folder share and inheritance
	verifyRes, err := h.grpcClient.VerifyFolderShare(c.Request().Context(), token, fileID)
	if err != nil || !verifyRes.IsValid {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File is not part of this shared link"})
	}

	meta, err := h.GetCachedMetadata(c.Request().Context(), fileID)
	if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	info, err := h.downloader.GetDownloadInfo(meta)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "attachment")
}

func (h *FileHandler) StreamSharedFolderFile(c echo.Context) error {
	token := c.Param("token")
	fileID := c.Param("fileId")

	// Call NestJS Core to verify folder share and inheritance
	verifyRes, err := h.grpcClient.VerifyFolderShare(c.Request().Context(), token, fileID)
	if err != nil || !verifyRes.IsValid {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File is not part of this shared link"})
	}

	meta, err := h.GetCachedMetadata(c.Request().Context(), fileID)
	if err != nil || (meta.Status != "complete" && meta.Status != "buffered") {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	info, err := h.downloader.GetDownloadInfo(meta)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "inline")
}

func (h *FileHandler) PurgeFiles(c echo.Context) error {
	var req []struct {
		TelegramMessageID int   `json:"telegramMessageId"`
		BotID             int64 `json:"botId"`
	}
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid payload"})
	}

	go func() {
		ctx := context.Background()
		for _, item := range req {
			if item.TelegramMessageID != 0 {
				_ = h.telegramClient.DeleteMessage(ctx, item.TelegramMessageID, item.BotID)
				time.Sleep(50 * time.Millisecond)
			}
		}
	}()

	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}
