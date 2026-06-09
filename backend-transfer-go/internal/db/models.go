package db

import (
	"time"
)

// SystemSetting corresponds to the SystemSetting table
type SystemSetting struct {
	Key       string    `gorm:"column:key;primaryKey"`
	Value     string    `gorm:"column:value"`
	CreatedAt time.Time `gorm:"column:createdAt"`
	UpdatedAt time.Time `gorm:"column:updatedAt"`
}

func (SystemSetting) TableName() string {
	return "SystemSetting"
}

// User corresponds to the User table
type User struct {
	ID                  string     `gorm:"column:id;primaryKey"`
	Username            string     `gorm:"column:username;unique"`
	Password            string     `gorm:"column:password"`
	Role                string     `gorm:"column:role"`
	Quota               int64      `gorm:"column:quota"`
	UsedSpace           int64      `gorm:"column:usedSpace"`
	DailyBandwidthLimit *int64     `gorm:"column:dailyBandwidthLimit"`
	DailyBandwidthUsed  int64      `gorm:"column:dailyBandwidthUsed"`
	LastBandwidthReset  time.Time  `gorm:"column:lastBandwidthReset"`
	CreatedAt           time.Time  `gorm:"column:createdAt"`
	UpdatedAt           time.Time  `gorm:"column:updatedAt"`
	IsCleaningTrash     bool       `gorm:"column:isCleaningTrash"`
}

func (User) TableName() string {
	return "User"
}

// GuestTracker corresponds to the GuestTracker table
type GuestTracker struct {
	IPAddress          string    `gorm:"column:ipAddress;primaryKey"`
	DailyBandwidthUsed int64     `gorm:"column:dailyBandwidthUsed"`
	LastBandwidthReset time.Time `gorm:"column:lastBandwidthReset"`
	CreatedAt          time.Time `gorm:"column:createdAt"`
	UpdatedAt          time.Time `gorm:"column:updatedAt"`
}

func (GuestTracker) TableName() string {
	return "GuestTracker"
}

// Folder corresponds to the Folder table
type Folder struct {
	ID                  string     `gorm:"column:id;primaryKey"`
	Name                string     `gorm:"column:name"`
	ParentID            *string    `gorm:"column:parentId"`
	UserID              string     `gorm:"column:userId"`
	DeletedAt           *time.Time `gorm:"column:deletedAt"`
	Visibility          string     `gorm:"column:visibility"`
	ShareToken          *string    `gorm:"column:shareToken;unique"`
	S3PublicAccess      bool       `gorm:"column:s3PublicAccess"`
	S3PublicListObjects bool       `gorm:"column:s3PublicListObjects"`
	CreatedAt           time.Time  `gorm:"column:createdAt"`
	UpdatedAt           time.Time  `gorm:"column:updatedAt"`
}

func (Folder) TableName() string {
	return "Folder"
}

// FileRecord corresponds to the FileRecord table
type FileRecord struct {
	ID                string     `gorm:"column:id;primaryKey"`
	Filename          string     `gorm:"column:filename"`
	Size              int64      `gorm:"column:size"`
	MimeType          string     `gorm:"column:mimeType"`
	TelegramFileID    *string    `gorm:"column:telegramFileId"`
	TelegramMessageID *int       `gorm:"column:telegramMessageId"`
	BotID             int64      `gorm:"column:botId"`
	IsChunked         bool       `gorm:"column:isChunked"`
	TotalChunks       int        `gorm:"column:totalChunks"`
	Status            string     `gorm:"column:status"`
	TempStorageKey    *string    `gorm:"column:tempStorageKey"`
	BufferRetries     int        `gorm:"column:bufferRetries"`
	Visibility        string     `gorm:"column:visibility"`
	ShareToken        *string    `gorm:"column:shareToken;unique"`
	DownloadLimit24h  *int       `gorm:"column:downloadLimit24h"`
	Downloads24h      int        `gorm:"column:downloads24h"`
	BandwidthLimit24h *int64     `gorm:"column:bandwidthLimit24h"`
	BandwidthUsed24h  int64      `gorm:"column:bandwidthUsed24h"`
	LastDownloadReset time.Time  `gorm:"column:lastDownloadReset"`
	IsEncrypted       bool       `gorm:"column:isEncrypted"`
	EncryptionAlgo    *string    `gorm:"column:encryptionAlgo"`
	EncryptionIv      *string    `gorm:"column:encryptionIv"`
	EncryptedKey      *string    `gorm:"column:encryptedKey"`
	Etag              *string    `gorm:"column:etag"`
	DeletedAt         *time.Time `gorm:"column:deletedAt"`
	FolderID          *string    `gorm:"column:folderId"`
	UserID            string     `gorm:"column:userId"`
	CreatedAt         time.Time  `gorm:"column:createdAt"`
	UpdatedAt         time.Time  `gorm:"column:updatedAt"`
}

func (FileRecord) TableName() string {
	return "FileRecord"
}

// S3Credential corresponds to the S3Credential table
type S3Credential struct {
	ID              string    `gorm:"column:id;primaryKey"`
	UserID          string    `gorm:"column:userId"`
	AccessKeyID     string    `gorm:"column:accessKeyId;unique"`
	SecretAccessKey string    `gorm:"column:secretAccessKey"`
	Label           string    `gorm:"column:label"`
	IsActive        bool      `gorm:"column:isActive"`
	CreatedAt       time.Time `gorm:"column:createdAt"`
	UpdatedAt       time.Time `gorm:"column:updatedAt"`
}

func (S3Credential) TableName() string {
	return "S3Credential"
}

// FileChunk corresponds to the FileChunk table
type FileChunk struct {
	ID                string    `gorm:"column:id;primaryKey"`
	FileID            string    `gorm:"column:fileId"`
	ChunkIndex        int       `gorm:"column:chunkIndex"`
	Size              int       `gorm:"column:size"`
	TelegramFileID    *string   `gorm:"column:telegramFileId"`
	TelegramMessageID *int      `gorm:"column:telegramMessageId"`
	BotID             int64     `gorm:"column:botId"`
	EncryptionIv      *string   `gorm:"column:encryptionIv"`
	Etag              *string   `gorm:"column:etag"`
	CreatedAt         time.Time `gorm:"column:createdAt"`
	TempStorageKey    *string   `gorm:"column:tempStorageKey"`
	Status            string    `gorm:"column:status"`
}

func (FileChunk) TableName() string {
	return "FileChunk"
}

// DownloadJob corresponds to the DownloadJob table
type DownloadJob struct {
	ID             string     `gorm:"column:id;primaryKey"`
	UserID         *string    `gorm:"column:userId"`
	ShareToken     *string    `gorm:"column:shareToken"`
	Status         string     `gorm:"column:status"`
	FileIDs        string     `gorm:"column:fileIds"`    // JSON string in DB
	FolderIDs      string     `gorm:"column:folderIds"`  // JSON string in DB
	TotalFiles     int        `gorm:"column:totalFiles"`
	ProcessedFiles int        `gorm:"column:processedFiles"`
	TotalSize      int64      `gorm:"column:totalSize"`
	ZipParts       string     `gorm:"column:zipParts"`   // JSON string in DB
	ErrorMessage   *string    `gorm:"column:errorMessage"`
	ExpiresAt      *time.Time `gorm:"column:expiresAt"`
	CreatedAt      time.Time  `gorm:"column:createdAt"`
	UpdatedAt      time.Time  `gorm:"column:updatedAt"`
}

func (DownloadJob) TableName() string {
	return "DownloadJob"
}
