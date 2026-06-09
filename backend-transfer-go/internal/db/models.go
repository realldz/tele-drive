package db

import (
	"time"
)

// SystemSetting corresponds to the SystemSetting table
type SystemSetting struct {
	Key       string    `gorm:"column:key;primaryKey" json:"key"`
	Value     string    `gorm:"column:value" json:"value"`
	CreatedAt time.Time `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt time.Time `gorm:"column:updatedAt" json:"updatedAt"`
}

func (SystemSetting) TableName() string {
	return "SystemSetting"
}

// User corresponds to the User table
type User struct {
	ID                  string     `gorm:"column:id;primaryKey" json:"id"`
	Username            string     `gorm:"column:username;unique" json:"username"`
	Password            string     `gorm:"column:password" json:"-"`
	Role                string     `gorm:"column:role" json:"role"`
	Quota               int64      `gorm:"column:quota" json:"quota"`
	UsedSpace           int64      `gorm:"column:usedSpace" json:"usedSpace"`
	DailyBandwidthLimit *int64     `gorm:"column:dailyBandwidthLimit" json:"dailyBandwidthLimit"`
	DailyBandwidthUsed  int64      `gorm:"column:dailyBandwidthUsed" json:"dailyBandwidthUsed"`
	LastBandwidthReset  time.Time  `gorm:"column:lastBandwidthReset" json:"lastBandwidthReset"`
	CreatedAt           time.Time  `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt           time.Time  `gorm:"column:updatedAt" json:"updatedAt"`
	IsCleaningTrash     bool       `gorm:"column:isCleaningTrash" json:"isCleaningTrash"`
}

func (User) TableName() string {
	return "User"
}

// GuestTracker corresponds to the GuestTracker table
type GuestTracker struct {
	IPAddress          string    `gorm:"column:ipAddress;primaryKey" json:"ipAddress"`
	DailyBandwidthUsed int64     `gorm:"column:dailyBandwidthUsed" json:"dailyBandwidthUsed"`
	LastBandwidthReset time.Time `gorm:"column:lastBandwidthReset" json:"lastBandwidthReset"`
	CreatedAt          time.Time `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt          time.Time `gorm:"column:updatedAt" json:"updatedAt"`
}

func (GuestTracker) TableName() string {
	return "GuestTracker"
}

// Folder corresponds to the Folder table
type Folder struct {
	ID                  string     `gorm:"column:id;primaryKey" json:"id"`
	Name                string     `gorm:"column:name" json:"name"`
	ParentID            *string    `gorm:"column:parentId" json:"parentId"`
	UserID              string     `gorm:"column:userId" json:"userId"`
	DeletedAt           *time.Time `gorm:"column:deletedAt" json:"deletedAt"`
	Visibility          string     `gorm:"column:visibility" json:"visibility"`
	ShareToken          *string    `gorm:"column:shareToken;unique" json:"shareToken"`
	S3PublicAccess      bool       `gorm:"column:s3PublicAccess" json:"s3PublicAccess"`
	S3PublicListObjects bool       `gorm:"column:s3PublicListObjects" json:"s3PublicListObjects"`
	CreatedAt           time.Time  `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt           time.Time  `gorm:"column:updatedAt" json:"updatedAt"`
}

func (Folder) TableName() string {
	return "Folder"
}

// FileRecord corresponds to the FileRecord table
type FileRecord struct {
	ID                string     `gorm:"column:id;primaryKey" json:"id"`
	Filename          string     `gorm:"column:filename" json:"filename"`
	Size              int64      `gorm:"column:size" json:"size"`
	MimeType          string     `gorm:"column:mimeType" json:"mimeType"`
	TelegramFileID    *string    `gorm:"column:telegramFileId" json:"telegramFileId"`
	TelegramMessageID *int       `gorm:"column:telegramMessageId" json:"telegramMessageId"`
	BotID             int64      `gorm:"column:botId" json:"botId"`
	IsChunked         bool       `gorm:"column:isChunked" json:"isChunked"`
	TotalChunks       int        `gorm:"column:totalChunks" json:"totalChunks"`
	Status            string     `gorm:"column:status" json:"status"`
	TempStorageKey    *string    `gorm:"column:tempStorageKey" json:"tempStorageKey"`
	BufferRetries     int        `gorm:"column:bufferRetries" json:"bufferRetries"`
	Visibility        string     `gorm:"column:visibility" json:"visibility"`
	ShareToken        *string    `gorm:"column:shareToken;unique" json:"shareToken"`
	DownloadLimit24h  *int       `gorm:"column:downloadLimit24h" json:"downloadLimit24h"`
	Downloads24h      int        `gorm:"column:downloads24h" json:"downloads24h"`
	BandwidthLimit24h *int64     `gorm:"column:bandwidthLimit24h" json:"bandwidthLimit24h"`
	BandwidthUsed24h  int64      `gorm:"column:bandwidthUsed24h" json:"bandwidthUsed24h"`
	LastDownloadReset time.Time  `gorm:"column:lastDownloadReset" json:"lastDownloadReset"`
	IsEncrypted       bool       `gorm:"column:isEncrypted" json:"isEncrypted"`
	EncryptionAlgo    *string    `gorm:"column:encryptionAlgo" json:"encryptionAlgo"`
	EncryptionIv      *string    `gorm:"column:encryptionIv" json:"encryptionIv"`
	EncryptedKey      *string    `gorm:"column:encryptedKey" json:"encryptedKey"`
	Etag              *string    `gorm:"column:etag" json:"etag"`
	DeletedAt         *time.Time `gorm:"column:deletedAt" json:"deletedAt"`
	FolderID          *string    `gorm:"column:folderId" json:"folderId"`
	UserID            string     `gorm:"column:userId" json:"userId"`
	CreatedAt         time.Time  `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt         time.Time  `gorm:"column:updatedAt" json:"updatedAt"`
}

func (FileRecord) TableName() string {
	return "FileRecord"
}

// S3Credential corresponds to the S3Credential table
type S3Credential struct {
	ID              string    `gorm:"column:id;primaryKey" json:"id"`
	UserID          string    `gorm:"column:userId" json:"userId"`
	AccessKeyID     string    `gorm:"column:accessKeyId;unique" json:"accessKeyId"`
	SecretAccessKey string    `gorm:"column:secretAccessKey" json:"-"`
	Label           string    `gorm:"column:label" json:"label"`
	IsActive        bool      `gorm:"column:isActive" json:"isActive"`
	CreatedAt       time.Time `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt       time.Time `gorm:"column:updatedAt" json:"updatedAt"`
}

func (S3Credential) TableName() string {
	return "S3Credential"
}

// FileChunk corresponds to the FileChunk table
type FileChunk struct {
	ID                string    `gorm:"column:id;primaryKey" json:"id"`
	FileID            string    `gorm:"column:fileId" json:"fileId"`
	ChunkIndex        int       `gorm:"column:chunkIndex" json:"chunkIndex"`
	Size              int       `gorm:"column:size" json:"size"`
	TelegramFileID    *string   `gorm:"column:telegramFileId" json:"telegramFileId"`
	TelegramMessageID *int      `gorm:"column:telegramMessageId" json:"telegramMessageId"`
	BotID             int64     `gorm:"column:botId" json:"botId"`
	EncryptionIv      *string   `gorm:"column:encryptionIv" json:"encryptionIv"`
	Etag              *string   `gorm:"column:etag" json:"etag"`
	CreatedAt         time.Time `gorm:"column:createdAt" json:"createdAt"`
	TempStorageKey    *string   `gorm:"column:tempStorageKey" json:"tempStorageKey"`
	Status            string    `gorm:"column:status" json:"status"`
}

func (FileChunk) TableName() string {
	return "FileChunk"
}

// DownloadJob corresponds to the DownloadJob table
type DownloadJob struct {
	ID             string     `gorm:"column:id;primaryKey" json:"id"`
	UserID         *string    `gorm:"column:userId" json:"userId"`
	ShareToken     *string    `gorm:"column:shareToken" json:"shareToken"`
	Status         string     `gorm:"column:status" json:"status"`
	FileIDs        string     `gorm:"column:fileIds" json:"fileIds"`    // JSON string in DB
	FolderIDs      string     `gorm:"column:folderIds" json:"folderIds"`  // JSON string in DB
	TotalFiles     int        `gorm:"column:totalFiles" json:"totalFiles"`
	ProcessedFiles int        `gorm:"column:processedFiles" json:"processedFiles"`
	TotalSize      int64      `gorm:"column:totalSize" json:"totalSize"`
	ZipParts       string     `gorm:"column:zipParts" json:"zipParts"`   // JSON string in DB
	ErrorMessage   *string    `gorm:"column:errorMessage" json:"errorMessage"`
	ExpiresAt      *time.Time `gorm:"column:expiresAt" json:"expiresAt"`
	CreatedAt      time.Time  `gorm:"column:createdAt" json:"createdAt"`
	UpdatedAt      time.Time  `gorm:"column:updatedAt" json:"updatedAt"`
}

func (DownloadJob) TableName() string {
	return "DownloadJob"
}
