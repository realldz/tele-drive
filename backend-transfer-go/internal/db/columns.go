package db

const (
	ColUserID             = `"userId"`
	ColFolderID           = `"folderId"`
	ColDeletedAt          = `"deletedAt"`
	ColUsedSpace          = `"usedSpace"`
	ColCreatedAt          = `"createdAt"`
	ColUpdatedAt          = `"updatedAt"`
	ColDailyBandwidthUsed = `"dailyBandwidthUsed"`
	ColDailyBandwidthLimit = `"dailyBandwidthLimit"`
	ColLastBandwidthReset = `"lastBandwidthReset"`
	ColIsCleaningTrash    = `"isCleaningTrash"`
	ColBufferRetries      = `"bufferRetries"`
	ColProcessedFiles     = `"processedFiles"`
	ColIsEncrypted        = `"isEncrypted"`
	ColTotalChunks        = `"totalChunks"`
	ColEncryptionAlgo     = `"encryptionAlgo"`
	ColEncryptionIv       = `"encryptionIv"`
	ColEncryptedKey       = `"encryptedKey"`
	ColTelegramFileId     = `"telegramFileId"`
	ColTelegramMessageId  = `"telegramMessageId"`
	ColBotId              = `"botId"`
	ColTempStorageKey     = `"tempStorageKey"`
	ColFileId             = `"fileId"`
	ColChunkIndex         = `"chunkIndex"`
	ColDownloadLimit24h   = `"downloadLimit24h"`
	ColDownloads24h       = `"downloads24h"`
	ColBandwidthLimit24h  = `"bandwidthLimit24h"`
	ColBandwidthUsed24h   = `"bandwidthUsed24h"`
)
