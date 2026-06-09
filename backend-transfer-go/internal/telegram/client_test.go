package telegram

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/redis/go-redis/v9"
)

func TestTelegramClient(t *testing.T) {
	// 1. Create mock Telegram HTTP server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		// Route based on request path
		if strings.HasSuffix(r.URL.Path, "/getMe") {
			if strings.Contains(r.URL.Path, "/botmock_main_token/") {
				w.Write([]byte(`{"ok":true,"result":{"id":12345,"is_bot":true,"username":"MockBot"}}`))
			} else {
				w.Write([]byte(`{"ok":true,"result":{"id":67890,"is_bot":true,"username":"MockBot2"}}`))
			}
		} else if strings.HasSuffix(r.URL.Path, "/getFile") {
			w.Write([]byte(`{"ok":true,"result":{"file_id":"mock_file_id","file_size":100,"file_path":"documents/mock.dat"}}`))
		} else if strings.HasSuffix(r.URL.Path, "/sendDocument") {
			w.Write([]byte(`{"ok":true,"result":{"message_id":54321,"document":{"file_id":"new_mock_file_id","file_name":"test.txt","file_size":11}}}`))
		} else if strings.HasSuffix(r.URL.Path, "/deleteMessage") {
			w.Write([]byte(`{"ok":true,"result":true}`))
		} else if strings.HasSuffix(r.URL.Path, "/forwardMessage") {
			w.Write([]byte(`{"ok":true,"result":{"message_id":9999,"document":{"file_id":"forwarded_file_id","file_name":"test.txt","file_size":11}}}`))
		} else {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"ok":false,"description":"Not Found"}`))
		}
	}))
	defer server.Close()

	ctx := context.Background()
	rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	defer rdb.Close()

	// 2. Initialize TelegramClient pointing to mock server
	client := NewTelegramClient(server.URL, "-10012345678", "mock_main_token", rdb, 18)

	err := client.Init(ctx, []string{"mock_extra_token"})
	if err != nil {
		t.Fatalf("Failed to init client: %v", err)
	}

	if client.mainBot.ID != 12345 {
		t.Errorf("Expected main bot ID to be 12345, got %d", client.mainBot.ID)
	}

	// 3. Test getFileLink
	link, err := client.GetFileLink(ctx, "mock_file_id", 12345)
	if err != nil {
		t.Fatalf("Failed to get file link: %v", err)
	}
	expectedLink := fmt.Sprintf("%s/file/botmock_main_token/documents/mock.dat", server.URL)
	if link != expectedLink {
		t.Errorf("Expected link %s, got %s", expectedLink, link)
	}

	// Test caching: query again, should hit the cache immediately
	link2, err := client.GetFileLink(ctx, "mock_file_id", 12345)
	if err != nil {
		t.Fatalf("Failed to get cached file link: %v", err)
	}
	if link2 != expectedLink {
		t.Errorf("Expected cached link %s, got %s", expectedLink, link2)
	}

	// 4. Test upload file
	// Verify that we can bypass rate limiting in test or skip if Redis is not running
	_, pingErr := rdb.Ping(ctx).Result()
	if pingErr != nil {
		t.Log("Redis is down; skipping upload test that requires bot slot acquisition")
	} else {
		content := []byte("hello world")
		buf := bytes.NewReader(content)
		fileID, msgID, botID, err := client.UploadFile(ctx, buf, "test.txt", int64(len(content)))
		if err != nil {
			t.Fatalf("Failed to upload file: %v", err)
		}
		if fileID != "new_mock_file_id" {
			t.Errorf("Expected uploaded file ID to be new_mock_file_id, got %s", fileID)
		}
		if msgID != 54321 {
			t.Errorf("Expected uploaded message ID to be 54321, got %d", msgID)
		}
		if botID != 12345 {
			t.Errorf("Expected uploaded bot ID to be 12345, got %d", botID)
		}
	}

	// 5. Test recover file
	recFileID, recBotID, err := client.RecoverFileID(ctx, 54321)
	if err != nil {
		t.Fatalf("Failed to recover file ID: %v", err)
	}
	if recFileID != "forwarded_file_id" {
		t.Errorf("Expected recovered file ID to be forwarded_file_id, got %s", recFileID)
	}
	if recBotID != 12345 {
		t.Errorf("Expected recovered bot ID to be 12345, got %d", recBotID)
	}

	// 6. Test delete message
	err = client.DeleteMessage(ctx, 54321, 12345)
	if err != nil {
		t.Fatalf("Failed to delete message: %v", err)
	}
}
