package db

import (
	"strings"
	"testing"
)

func TestColumnNamesAreQuoted(t *testing.T) {
	cols := map[string]string{
		ColUserID:             "userId",
		ColFolderID:           "folderId",
		ColDeletedAt:          "deletedAt",
		ColUsedSpace:          "usedSpace",
		ColCreatedAt:          "createdAt",
		ColUpdatedAt:          "updatedAt",
		ColDailyBandwidthUsed: "dailyBandwidthUsed",
		ColIsCleaningTrash:    "isCleaningTrash",
		ColBufferRetries:      "bufferRetries",
		ColProcessedFiles:     "processedFiles",
		ColIsEncrypted:        "isEncrypted",
		ColTotalChunks:        "totalChunks",
		ColTelegramFileId:     "telegramFileId",
		ColBotId:              "botId",
		ColChunkIndex:         "chunkIndex",
	}

	for constName, rawCol := range cols {
		expected := `"` + rawCol + `"`
		if constName != expected {
			t.Errorf("Column constant = %q, want %q (mismatch for %s)", constName, expected, rawCol)
		}
		if !strings.HasPrefix(constName, `"`) || !strings.HasSuffix(constName, `"`) {
			t.Errorf("Column constant %s must be double-quoted", constName)
		}
	}
}
