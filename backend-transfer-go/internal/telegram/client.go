package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

type Bot struct {
	ID       int64
	Token    string
	Username string
}

type TelegramClient struct {
	apiRoot        string
	chatID         string
	mainBot        *Bot
	bots           map[int64]*Bot
	botList        []*Bot
	botRateLimiter *BotRateLimiter
	httpClient     *http.Client

	// Cache & Singleflight for file links
	fileLinkCache sync.Map // fileID -> CachedLink
	sfGroup       singleflight.Group
	semaphore     chan struct{}
}

type CachedLink struct {
	URL      string
	ExpiryAt time.Time
}

type TelegramResponse struct {
	OK          bool            `json:"ok"`
	Description string          `json:"description,omitempty"`
	ErrorCode   int             `json:"error_code,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Parameters  *struct {
		RetryAfter int `json:"retry_after,omitempty"`
	} `json:"parameters,omitempty"`
}

type Message struct {
	MessageID int       `json:"message_id"`
	Document  *Document `json:"document,omitempty"`
}

type Document struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name"`
	FileSize int64  `json:"file_size"`
}

type FileResult struct {
	FileID   string `json:"file_id"`
	FileSize int64  `json:"file_size"`
	FilePath string `json:"file_path"`
}

type GetMeResult struct {
	ID       int64  `json:"id"`
	IsBot    bool   `json:"is_bot"`
	Username string `json:"username"`
}

func NewTelegramClient(apiRoot, chatID string, mainToken string, rdb *redis.Client, rateLimit int) *TelegramClient {
	if apiRoot == "" {
		apiRoot = "https://api.telegram.org"
	}

	mainBot := &Bot{Token: mainToken}

	return &TelegramClient{
		apiRoot:        apiRoot,
		chatID:         chatID,
		mainBot:        mainBot,
		bots:           make(map[int64]*Bot),
		botList:        []*Bot{},
		botRateLimiter: NewBotRateLimiter(rdb, []int64{}, rateLimit),
		httpClient: &http.Client{
			Timeout: 5 * time.Minute, // High timeout for large file uploads/downloads
		},
		semaphore: make(chan struct{}, 3), // SEMAPHORE_LIMIT = 3
	}
}

func (c *TelegramClient) Init(ctx context.Context, extraTokens []string) error {
	// Call getMe for mainBot
	mainBotMe, err := c.getMe(ctx, c.mainBot.Token)
	if err != nil {
		return fmt.Errorf("failed to getMe for main bot: %w", err)
	}
	c.mainBot.ID = mainBotMe.ID
	c.mainBot.Username = mainBotMe.Username
	c.bots[mainBotMe.ID] = c.mainBot
	c.botList = append(c.botList, c.mainBot)

	// Call getMe for extra bots
	for _, token := range extraTokens {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		botMe, err := c.getMe(ctx, token)
		if err != nil {
			return fmt.Errorf("failed to getMe for extra bot %s: %w", token[:10], err)
		}
		b := &Bot{
			ID:       botMe.ID,
			Token:    token,
			Username: botMe.Username,
		}
		c.bots[botMe.ID] = b
		c.botList = append(c.botList, b)
	}

	// Build bot ID list for rate limiter
	botIDs := make([]int64, len(c.botList))
	for i, b := range c.botList {
		botIDs[i] = b.ID
	}
	c.botRateLimiter.botIDs = botIDs

	return nil
}

func (c *TelegramClient) getMe(ctx context.Context, token string) (*GetMeResult, error) {
	urlStr := fmt.Sprintf("%s/bot%s/getMe", c.apiRoot, token)
	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tgResp TelegramResponse
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return nil, err
	}

	if !tgResp.OK {
		return nil, fmt.Errorf("getMe failed: %s", tgResp.Description)
	}

	var me GetMeResult
	if err := json.Unmarshal(tgResp.Result, &me); err != nil {
		return nil, err
	}

	return &me, nil
}

func (c *TelegramClient) withRetry(ctx context.Context, operation string, fn func() (*http.Response, error)) (*http.Response, error) {
	var lastErr error
	maxRetries := 3
	baseDelay := 1 * time.Second

	for attempt := 0; attempt <= maxRetries; attempt++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		resp, err := fn()
		if err == nil {
			if resp.StatusCode == http.StatusOK {
				return resp, nil
			}

			// Read response to check description / error code
			var tgResp TelegramResponse
			bodyBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			_ = json.Unmarshal(bodyBytes, &tgResp)

			// Restore body reader just in case
			resp.Body = io.NopCloser(bytes.NewReader(bodyBytes))

			isRetryable := false
			var delay time.Duration

			if resp.StatusCode == 429 {
				isRetryable = true
				if tgResp.Parameters != nil && tgResp.Parameters.RetryAfter > 0 {
					delay = time.Duration(tgResp.Parameters.RetryAfter) * time.Second
				} else {
					delay = baseDelay * (1 << attempt)
				}
			} else if resp.StatusCode >= 500 {
				isRetryable = true
				delay = baseDelay * (1 << attempt)
			} else if strings.Contains(strings.ToLower(tgResp.Description), "too many requests") {
				isRetryable = true
				delay = baseDelay * (1 << attempt)
			}

			if isRetryable && attempt < maxRetries {
				time.Sleep(delay)
				continue
			}

			resp.Body.Close()
			return resp, fmt.Errorf("telegram API error status=%d desc=%s", resp.StatusCode, tgResp.Description)
		}

		lastErr = err
		if attempt < maxRetries {
			time.Sleep(baseDelay * (1 << attempt))
			continue
		}
	}
	return nil, fmt.Errorf("failed after %d retries: %w", maxRetries, lastErr)
}

func (c *TelegramClient) UploadFile(ctx context.Context, r io.Reader, filename string, size int64) (string, int, int64, error) {
	// Acquire slot
	botID, err := c.botRateLimiter.AcquireUploadSlot(ctx)
	if err != nil {
		return "", 0, 0, fmt.Errorf("failed to acquire upload slot: %w", err)
	}

	bot := c.bots[botID]

	// Call sendDocument
	fileID, messageID, err := c.sendDocument(ctx, bot, r, filename, size)
	if err != nil {
		return "", 0, 0, err
	}

	return fileID, messageID, botID, nil
}

func (c *TelegramClient) sendDocument(ctx context.Context, bot *Bot, r io.Reader, filename string, size int64) (string, int, error) {
	// Prepare pipe for multipart streaming
	bodyReader, bodyWriter := io.Pipe()
	mw := multipart.NewWriter(bodyWriter)

	errChan := make(chan error, 1)

	go func() {
		defer bodyWriter.Close()
		defer mw.Close()

		if err := mw.WriteField("chat_id", c.chatID); err != nil {
			errChan <- err
			return
		}

		fw, err := mw.CreateFormFile("document", filename)
		if err != nil {
			errChan <- err
			return
		}

		if _, err := io.Copy(fw, r); err != nil {
			errChan <- err
			return
		}
		errChan <- nil
	}()

	urlStr := fmt.Sprintf("%s/bot%s/sendDocument", c.apiRoot, bot.Token)

	resp, err := c.withRetry(ctx, "sendDocument", func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", urlStr, bodyReader)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", mw.FormDataContentType())
		return c.httpClient.Do(req)
	})

	writeErr := <-errChan
	if writeErr != nil {
		if resp != nil {
			resp.Body.Close()
		}
		return "", 0, fmt.Errorf("failed to write multipart payload: %w", writeErr)
	}

	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()

	var tgResp TelegramResponse
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return "", 0, err
	}

	if !tgResp.OK {
		return "", 0, fmt.Errorf("telegram sendDocument failed: %s", tgResp.Description)
	}

	var msg Message
	if err := json.Unmarshal(tgResp.Result, &msg); err != nil {
		return "", 0, err
	}

	if msg.Document == nil {
		return "", 0, errors.New("telegram bot API did not return a valid document object")
	}

	return msg.Document.FileID, msg.MessageID, nil
}

func (c *TelegramClient) GetFileLink(ctx context.Context, fileID string, botID int64) (string, error) {
	// 1. Check cache
	if val, ok := c.fileLinkCache.Load(fileID); ok {
		cached := val.(CachedLink)
		if time.Now().Before(cached.ExpiryAt) {
			return cached.URL, nil
		}
	}

	// 2. Singleflight group call
	linkInterface, err, _ := c.sfGroup.Do(fileID, func() (interface{}, error) {
		// Acquire semaphore
		select {
		case c.semaphore <- struct{}{}:
			defer func() { <-c.semaphore }()
		case <-ctx.Done():
			return "", ctx.Err()
		}

		// Double check cache after semaphore
		if val, ok := c.fileLinkCache.Load(fileID); ok {
			cached := val.(CachedLink)
			if time.Now().Before(cached.ExpiryAt) {
				return cached.URL, nil
			}
		}

		// Query Telegram API
		link, err := c.resolveFileLink(ctx, fileID, botID)
		if err != nil {
			return "", err
		}

		// Cache it
		c.fileLinkCache.Store(fileID, CachedLink{
			URL:      link,
			ExpiryAt: time.Now().Add(50 * time.Minute),
		})

		return link, nil
	})

	if err != nil {
		return "", err
	}
	return linkInterface.(string), nil
}

func (c *TelegramClient) resolveFileLink(ctx context.Context, fileID string, botID int64) (string, error) {
	bot := c.mainBot
	if b, ok := c.bots[botID]; ok {
		bot = b
	}

	urlStr := fmt.Sprintf("%s/bot%s/getFile?file_id=%s", c.apiRoot, bot.Token, url.QueryEscape(fileID))

	resp, err := c.withRetry(ctx, "getFile", func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
		if err != nil {
			return nil, err
		}
		return c.httpClient.Do(req)
	})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var tgResp TelegramResponse
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return "", err
	}

	if !tgResp.OK {
		return "", fmt.Errorf("telegram getFile failed: %s", tgResp.Description)
	}

	var fileResult FileResult
	if err := json.Unmarshal(tgResp.Result, &fileResult); err != nil {
		return "", err
	}

	downloadURL := fmt.Sprintf("%s/file/bot%s/%s", c.apiRoot, bot.Token, fileResult.FilePath)
	return downloadURL, nil
}

func (c *TelegramClient) DeleteMessage(ctx context.Context, messageID int, botID int64) error {
	bot := c.mainBot
	if b, ok := c.bots[botID]; ok {
		bot = b
	}

	urlStr := fmt.Sprintf("%s/bot%s/deleteMessage", c.apiRoot, bot.Token)

	payload := map[string]interface{}{
		"chat_id":    c.chatID,
		"message_id": messageID,
	}
	bodyBytes, _ := json.Marshal(payload)

	resp, err := c.withRetry(ctx, "deleteMessage", func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", urlStr, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		return c.httpClient.Do(req)
	})

	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "message can't be deleted") ||
			strings.Contains(errMsg, "message to delete not found") ||
			strings.Contains(errMsg, "message identifier is not specified") {
			return nil
		}
		return err
	}
	resp.Body.Close()

	return nil
}

func (c *TelegramClient) RecoverFileID(ctx context.Context, telegramMessageID int) (string, int64, error) {
	bot := c.mainBot
	urlStr := fmt.Sprintf("%s/bot%s/forwardMessage", c.apiRoot, bot.Token)

	payload := map[string]interface{}{
		"chat_id":              c.chatID,
		"from_chat_id":         c.chatID,
		"message_id":           telegramMessageID,
		"disable_notification": true,
	}
	bodyBytes, _ := json.Marshal(payload)

	resp, err := c.withRetry(ctx, "forwardMessage", func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", urlStr, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		return c.httpClient.Do(req)
	})
	if err != nil {
		return "", 0, fmt.Errorf("failed to forward message during recovery: %w", err)
	}
	defer resp.Body.Close()

	var tgResp TelegramResponse
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return "", 0, err
	}

	if !tgResp.OK {
		return "", 0, fmt.Errorf("telegram forwardMessage failed: %s", tgResp.Description)
	}

	var msg Message
	if err := json.Unmarshal(tgResp.Result, &msg); err != nil {
		return "", 0, err
	}

	if msg.Document == nil {
		return "", 0, errors.New("recovered message has no document")
	}

	go func() {
		ctxDel, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.DeleteMessage(ctxDel, msg.MessageID, bot.ID)
	}()

	return msg.Document.FileID, bot.ID, nil
}
