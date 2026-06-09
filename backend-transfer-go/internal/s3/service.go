package s3

import (
	"errors"
	"strings"
	"time"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"gorm.io/gorm"
)

type ObjectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
	ETag         string
}

type S3Service struct {
	database      *db.DB
	settingsCache *db.SettingsCache
}

func NewS3Service(database *db.DB, settingsCache *db.SettingsCache) *S3Service {
	return &S3Service{
		database:      database,
		settingsCache: settingsCache,
	}
}

// ListBuckets lists all root folders for the user (parentId is null)
func (s *S3Service) ListBuckets(userID string) ([]db.Folder, error) {
	var folders []db.Folder
	err := s.database.Where("\"userId\" = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID).
		Order("\"createdAt\" ASC").Find(&folders).Error
	return folders, err
}

// CreateBucket creates a root folder (bucket) if it does not exist
func (s *S3Service) CreateBucket(userID string, bucketName string) (db.Folder, error) {
	var folder db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucketName).First(&folder).Error
	if err == nil {
		return folder, nil
	}

	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return db.Folder{}, err
	}

	newFolder := db.Folder{
		ID:                  strings.ReplaceAll(time.Now().Format("20060102150405.000"), ".", "") + "-b", // simple unique ID generation
		Name:                bucketName,
		ParentID:            nil,
		UserID:              userID,
		Visibility:          "private",
		S3PublicAccess:      false,
		S3PublicListObjects: false,
		CreatedAt:           time.Now(),
		UpdatedAt:           time.Now(),
	}

	newFolder.ID = generateUUID()

	if err := s.database.Create(&newFolder).Error; err != nil {
		return db.Folder{}, err
	}

	return newFolder, nil
}

// DeleteBucket deletes a root folder (bucket) only if it is empty
func (s *S3Service) DeleteBucket(userID string, bucketName string) error {
	var folder db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucketName).First(&folder).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return errors.New("NoSuchBucket")
		}
		return err
	}

	// Check if empty
	var childFolderCount int64
	s.database.Model(&db.Folder{}).Where("\"parentId\" = ? AND \"deletedAt\" IS NULL", folder.ID).Count(&childFolderCount)

	var fileCount int64
	s.database.Model(&db.FileRecord{}).Where("\"folderId\" = ? AND \"deletedAt\" IS NULL", folder.ID).Count(&fileCount)

	if childFolderCount > 0 || fileCount > 0 {
		return errors.New("BucketNotEmpty")
	}

	now := time.Now()
	return s.database.Model(&folder).Update(db.ColDeletedAt, &now).Error
}

// ResolveKey maps bucket + object key (e.g. "docs/2024/report.pdf") to folderId + filename.
// If create=true, auto-creates missing intermediate folders.
func (s *S3Service) ResolveKey(userID string, bucketName string, key string, create bool) (*string, string, error) {
	var bucket db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucketName).First(&bucket).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if create {
				bucket, err = s.CreateBucket(userID, bucketName)
				if err != nil {
					return nil, "", err
				}
			} else {
				return nil, "", errors.New("NoSuchBucket")
			}
		} else {
			return nil, "", err
		}
	}

	return s.resolveKeyUnderFolder(userID, bucket.ID, key, create)
}

// ResolveKeyAsFolder resolves a key ending with "/" as a nested folder structure and returns leaf folder ID.
func (s *S3Service) ResolveKeyAsFolder(userID string, bucketName string, key string) (string, error) {
	if !strings.HasSuffix(key, "/") {
		return "", errors.New("InvalidArgument")
	}

	parts := splitKey(key)
	if len(parts) == 0 {
		return "", errors.New("InvalidArgument")
	}

	var bucket db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucketName).First(&bucket).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			bucket, err = s.CreateBucket(userID, bucketName)
			if err != nil {
				return "", err
			}
		} else {
			return "", err
		}
	}

	currentFolderID := bucket.ID
	for _, part := range parts {
		var folder db.Folder
		err = s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" = ? AND \"deletedAt\" IS NULL", userID, part, currentFolderID).First(&folder).Error
		if err == nil {
			currentFolderID = folder.ID
			continue
		}

		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return "", err
		}

		newFolder := db.Folder{
			ID:                  generateUUID(),
			Name:                part,
			ParentID:            &currentFolderID,
			UserID:              userID,
			Visibility:          "private",
			S3PublicAccess:      false,
			S3PublicListObjects: false,
			CreatedAt:           time.Now(),
			UpdatedAt:           time.Now(),
		}
		if err := s.database.Create(&newFolder).Error; err != nil {
			return "", err
		}
		currentFolderID = newFolder.ID
	}

	return currentFolderID, nil
}

// CleanupEmptyFolders climbs up the parentId chain and soft-deletes empty folders.
func (s *S3Service) CleanupEmptyFolders(userID string, folderID *string) error {
	currentFolderID := folderID

	for currentFolderID != nil {
		var folder db.Folder
		err := s.database.Where("id = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", *currentFolderID, userID).First(&folder).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}

		if folder.ParentID == nil {
			return nil // Don't cleanup the bucket (root folder) itself
		}

		var childFolderCount int64
		s.database.Model(&db.Folder{}).Where("\"parentId\" = ? AND \"deletedAt\" IS NULL", folder.ID).Count(&childFolderCount)

		var fileCount int64
		s.database.Model(&db.FileRecord{}).Where("\"folderId\" = ? AND \"deletedAt\" IS NULL", folder.ID).Count(&fileCount)

		if childFolderCount > 0 || fileCount > 0 {
			return nil
		}

		now := time.Now()
		if err := s.database.Model(&folder).Update(db.ColDeletedAt, &now).Error; err != nil {
			return err
		}

		currentFolderID = folder.ParentID
	}

	return nil
}

// DeleteFolderMarker deletes folder marker only if it is empty.
func (s *S3Service) DeleteFolderMarker(userID string, bucketName string, key string) (bool, error) {
	if !strings.HasSuffix(key, "/") {
		return false, nil
	}

	parts := splitKey(key)
	if len(parts) == 0 {
		return false, nil
	}

	var bucket db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucketName).First(&bucket).Error
	if err != nil {
		return false, nil
	}

	currentFolderID := bucket.ID
	for _, part := range parts {
		var folder db.Folder
		err = s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" = ? AND \"deletedAt\" IS NULL", userID, part, currentFolderID).First(&folder).Error
		if err != nil {
			return false, nil
		}
		currentFolderID = folder.ID
	}

	var childFolderCount int64
	s.database.Model(&db.Folder{}).Where("\"parentId\" = ? AND \"deletedAt\" IS NULL", currentFolderID).Count(&childFolderCount)

	var fileCount int64
	s.database.Model(&db.FileRecord{}).Where("\"folderId\" = ? AND \"deletedAt\" IS NULL", currentFolderID).Count(&fileCount)

	if childFolderCount > 0 || fileCount > 0 {
		return false, nil
	}

	now := time.Now()
	if err := s.database.Model(&db.Folder{}).Where("id = ?", currentFolderID).Update(db.ColDeletedAt, &now).Error; err != nil {
		return false, err
	}

	if err := s.CleanupEmptyFolders(userID, &currentFolderID); err != nil {
		return false, err
	}

	return true, nil
}
