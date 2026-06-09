package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
)

func (h *FileHandler) GenerateDownloadToken(c echo.Context) error {
	userID := c.Get("userId").(string)
	id := c.Param("id")

	var file db.FileRecord
	if err := h.database.Where("id = ? AND \"userId\" = ? AND status IN ('complete', 'buffered') AND \"deletedAt\" IS NULL", id, userID).First(&file).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	ttl := h.settingsCache.GetCachedSettingInt64("DOWNLOAD_URL_TTL_SECONDS", 300)
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

	var file db.FileRecord
	if err := h.database.Where("\"shareToken\" = ? AND status IN ('complete', 'buffered') AND \"deletedAt\" IS NULL", token).First(&file).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Shared file not found"})
	}

	ttl := h.settingsCache.GetCachedSettingInt64("DOWNLOAD_URL_TTL_SECONDS", 300)
	signedToken, err := h.cryptoEngine.CreateSignedToken(file.ID, "s", ttl, "")
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

	payload, err := h.cryptoEngine.VerifySignedToken(token)
	if err != nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Invalid or expired download link"})
	}

	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND status IN ('complete', 'buffered') AND \"deletedAt\" IS NULL", payload.FID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	info, err := h.downloader.GetDownloadInfo(fileRecord)
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
	ttl := h.settingsCache.GetCachedSettingInt64("STREAM_COOKIE_TTL_SECONDS", 3600)
	token, err := h.cryptoEngine.CreateStreamCookieToken(userID, ttl)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     "stream_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
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

	ttl := h.settingsCache.GetCachedSettingInt64("STREAM_COOKIE_TTL_SECONDS", 3600)
	token, err := h.cryptoEngine.CreateStreamCookieToken(subject, ttl)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     "stream_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
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

	var fileRecord db.FileRecord
	var err error
	if strings.HasPrefix(sub, "guest:") {
		// Public link check
		err = h.database.Where("id = ? AND status IN ('complete', 'buffered') AND \"deletedAt\" IS NULL AND \"visibility\" = 'PUBLIC_LINK'", id).First(&fileRecord).Error
	} else {
		// Owner check
		err = h.database.Where("id = ? AND \"userId\" = ? AND status IN ('complete', 'buffered') AND \"deletedAt\" IS NULL", id, sub).First(&fileRecord).Error
	}

	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	info, err := h.downloader.GetDownloadInfo(fileRecord)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "inline")
}

func (h *FileHandler) StreamSharedByCookie(c echo.Context) error {
	shareToken := c.Param("shareToken")

	var fileRecord db.FileRecord
	if err := h.database.Where("\"shareToken\" = ? AND status IN ('complete', 'buffered') AND \"deletedAt\" IS NULL", shareToken).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Shared file not found"})
	}

	info, err := h.downloader.GetDownloadInfo(fileRecord)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "inline")
}

func (h *FileHandler) DownloadSharedFile(c echo.Context) error {
	token := c.Param("token")
	fileID := c.Param("fileId")

	var rootSharedFolder db.Folder
	if err := h.database.Where("\"shareToken\" = ? AND \"deletedAt\" IS NULL", token).First(&rootSharedFolder).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Shared folder not found"})
	}

	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"deletedAt\" IS NULL", fileID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	if fileRecord.Status != "complete" && fileRecord.Status != "buffered" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File upload not completed yet"})
	}

	if fileRecord.FolderID == nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File is not part of this shared link"})
	}

	isDescendant, err := h.isDescendantOf(*fileRecord.FolderID, rootSharedFolder.ID)
	if err != nil || !isDescendant {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File is not part of this shared link"})
	}

	info, err := h.downloader.GetDownloadInfo(fileRecord)
	if err != nil {
		return err
	}

	rangeHeader := c.Request().Header.Get("Range")
	return h.downloader.ServeDownload(c, info, rangeHeader, "attachment")
}

func (h *FileHandler) StreamSharedFolderFile(c echo.Context) error {
	token := c.Param("token")
	fileID := c.Param("fileId")

	var rootSharedFolder db.Folder
	if err := h.database.Where("\"shareToken\" = ? AND \"deletedAt\" IS NULL", token).First(&rootSharedFolder).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "Shared folder not found"})
	}

	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"deletedAt\" IS NULL", fileID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File not found"})
	}

	if fileRecord.Status != "complete" && fileRecord.Status != "buffered" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File upload not completed yet"})
	}

	if fileRecord.FolderID == nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File is not part of this shared link"})
	}

	isDescendant, err := h.isDescendantOf(*fileRecord.FolderID, rootSharedFolder.ID)
	if err != nil || !isDescendant {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File is not part of this shared link"})
	}

	info, err := h.downloader.GetDownloadInfo(fileRecord)
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
