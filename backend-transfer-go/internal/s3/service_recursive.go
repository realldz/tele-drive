package s3

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"gorm.io/gorm"
)

func (s *S3Service) resolveKeyUnderFolder(userID string, rootFolderID string, key string, create bool) (*string, string, error) {
	parts := splitKey(key)
	if len(parts) == 0 {
		return nil, "", errors.New("Invalid key")
	}

	filename := parts[len(parts)-1]
	dirParts := parts[:len(parts)-1]

	currentFolderID := rootFolderID

	for _, part := range dirParts {
		var folder db.Folder
		err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" = ? AND \"deletedAt\" IS NULL", userID, part, currentFolderID).First(&folder).Error
		if err == nil {
			currentFolderID = folder.ID
		} else if errors.Is(err, gorm.ErrRecordNotFound) && create {
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
				return nil, "", err
			}
			currentFolderID = newFolder.ID
		} else {
			return nil, "", errors.New("NoSuchKey")
		}
	}

	return &currentFolderID, filename, nil
}

func (s *S3Service) FindObject(userID string, bucketName string, key string) (db.FileRecord, error) {
	folderID, filename, err := s.ResolveKey(userID, bucketName, key, false)
	if err != nil {
		return db.FileRecord{}, err
	}

	var file db.FileRecord
	err = s.database.Where("\"folderId\" = ? AND filename = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL AND status = 'complete'", folderID, filename, userID).First(&file).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return db.FileRecord{}, errors.New("NoSuchKey")
		}
		return db.FileRecord{}, err
	}
	return file, nil
}

func (s *S3Service) FindObjectRecords(userID string, bucketName string, key string) ([]db.FileRecord, error) {
	folderID, filename, err := s.ResolveKey(userID, bucketName, key, false)
	if err != nil {
		if err.Error() == "NoSuchKey" || err.Error() == "NoSuchBucket" {
			return nil, nil
		}
		return nil, err
	}

	var files []db.FileRecord
	err = s.database.Where("\"folderId\" = ? AND filename = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", folderID, filename, userID).
		Order("\"updatedAt\" DESC, id DESC").Find(&files).Error
	return files, err
}

func (s *S3Service) FindObjectPublic(userID string, bucketName string, key string) (db.FileRecord, error) {
	var bucket db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"s3PublicAccess\" = ? AND \"deletedAt\" IS NULL", userID, bucketName, true).First(&bucket).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return db.FileRecord{}, errors.New("NoSuchBucket")
		}
		return db.FileRecord{}, err
	}

	folderID, filename, err := s.resolveKeyUnderFolder(userID, bucket.ID, key, false)
	if err != nil {
		return db.FileRecord{}, err
	}

	var file db.FileRecord
	err = s.database.Where("\"folderId\" = ? AND filename = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL AND status = 'complete'", folderID, filename, userID).First(&file).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return db.FileRecord{}, errors.New("NoSuchKey")
		}
		return db.FileRecord{}, err
	}
	return file, nil
}

func (s *S3Service) ListObjects(userID string, bucketName string, prefix string, delimiter string, maxKeys int) ([]ObjectInfo, []string, error) {
	var bucket db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"deletedAt\" IS NULL", userID, bucketName).First(&bucket).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, errors.New("NoSuchBucket")
		}
		return nil, nil, err
	}

	objects, prefixes, err := s.listRecursiveOptimized(userID, bucket.ID, prefix, delimiter, maxKeys)
	if err != nil {
		return nil, nil, err
	}

	return objects, prefixes, nil
}

func (s *S3Service) ListObjectsPublic(userID string, bucketName string, prefix string, delimiter string, maxKeys int) ([]ObjectInfo, []string, error) {
	var bucket db.Folder
	err := s.database.Where("\"userId\" = ? AND name = ? AND \"parentId\" IS NULL AND \"s3PublicAccess\" = ? AND \"deletedAt\" IS NULL", userID, bucketName, true).First(&bucket).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, errors.New("NoSuchBucket")
		}
		return nil, nil, err
	}

	if !bucket.S3PublicListObjects {
		return nil, nil, errors.New("AccessDenied")
	}

	objects, prefixes, err := s.listRecursiveOptimized(userID, bucket.ID, prefix, delimiter, maxKeys)
	if err != nil {
		return nil, nil, err
	}

	return objects, prefixes, nil
}

func (s *S3Service) listRecursiveOptimized(userID string, bucketID string, prefix string, delimiter string, maxKeys int) ([]ObjectInfo, []string, error) {
	var folders []db.Folder
	if err := s.database.Where("\"userId\" = ? AND \"deletedAt\" IS NULL", userID).Find(&folders).Error; err != nil {
		return nil, nil, err
	}

	folderMap := make(map[string]db.Folder)
	childrenMap := make(map[string][]db.Folder)
	for _, f := range folders {
		folderMap[f.ID] = f
		if f.ParentID != nil {
			pID := *f.ParentID
			childrenMap[pID] = append(childrenMap[pID], f)
		}
	}

	folderPathMap := make(map[string]string)
	descendantFolderIds := make(map[string]bool)
	descendantFolderIds[bucketID] = true
	folderPathMap[bucketID] = ""

	queue := []string{bucketID}
	for len(queue) > 0 {
		currentID := queue[0]
		queue = queue[1:]
		currentPath := folderPathMap[currentID]
		children := childrenMap[currentID]
		for _, child := range children {
			var childPath string
			if currentPath != "" {
				childPath = currentPath + "/" + child.Name
			} else {
				childPath = child.Name
			}
			folderPathMap[child.ID] = childPath
			descendantFolderIds[child.ID] = true
			queue = append(queue, child.ID)
		}
	}

	var descendantFolderList []string
	for fID := range descendantFolderIds {
		descendantFolderList = append(descendantFolderList, fID)
	}

	var files []db.FileRecord
	if err := s.database.Where("\"userId\" = ? AND \"folderId\" IN ? AND \"deletedAt\" IS NULL AND status = 'complete'", userID, descendantFolderList).Find(&files).Error; err != nil {
		return nil, nil, err
	}

	filesByFolder := make(map[string][]db.FileRecord)
	for _, file := range files {
		fID := bucketID
		if file.FolderID != nil {
			fID = *file.FolderID
		}
		filesByFolder[fID] = append(filesByFolder[fID], file)
	}

	var objects []ObjectInfo
	commonPrefixes := make(map[string]bool)

	var traverse func(folderID string, currentPath string)
	traverse = func(folderID string, currentPath string) {
		if len(objects) >= maxKeys {
			return
		}

		folderFiles := filesByFolder[folderID]
		for _, file := range folderFiles {
			var key string
			if currentPath != "" {
				key = currentPath + "/" + file.Filename
			} else {
				key = file.Filename
			}

			if prefix != "" && !strings.HasPrefix(key, prefix) {
				continue
			}

			if delimiter != "" {
				rest := key[len(prefix):]
				delimIdx := strings.Index(rest, delimiter)
				if delimIdx != -1 {
					commonPrefixes[prefix+rest[:delimIdx+len(delimiter)]] = true
					continue
				}
			}

			etagStr := ""
			if file.Etag != nil {
				etagStr = *file.Etag
			} else {
				etagStr = `"` + file.ID + `"`
			}

			objects = append(objects, ObjectInfo{
				Key:          key,
				Size:         file.Size,
				LastModified: file.CreatedAt,
				ETag:         etagStr,
			})
		}

		if len(objects) >= maxKeys {
			return
		}

		subFolders := childrenMap[folderID]
		for _, folder := range subFolders {
			var folderPath string
			if currentPath != "" {
				folderPath = currentPath + "/" + folder.Name
			} else {
				folderPath = folder.Name
			}
			fullPath := folderPath + "/"

			if prefix != "" && !strings.HasPrefix(fullPath, prefix) && !strings.HasPrefix(prefix, fullPath) {
				continue
			}

			if delimiter != "" {
				if prefix != "" && strings.HasPrefix(prefix, fullPath) {
					traverse(folder.ID, folderPath)
					continue
				}

				rest := fullPath[len(prefix):]
				delimIdx := strings.Index(rest, delimiter)
				if delimIdx != -1 {
					commonPrefixes[prefix+rest[:delimIdx+len(delimiter)]] = true
					continue
				}
			}

			if delimiter == "" {
				hasChild := len(childrenMap[folder.ID]) > 0
				hasFile := len(filesByFolder[folder.ID]) > 0

				if !hasChild && !hasFile {
					if prefix == "" || strings.HasPrefix(fullPath, prefix) {
						objects = append(objects, ObjectInfo{
							Key:          fullPath,
							Size:         0,
							LastModified: folder.UpdatedAt,
							ETag:         `"` + folder.ID + `"`,
						})
					}
					continue
				}
			}

			traverse(folder.ID, folderPath)
		}
	}

	traverse(bucketID, "")

	// Sort objects lexicographically by Key
	sort.Slice(objects, func(i, j int) bool {
		return objects[i].Key < objects[j].Key
	})

	// Sort common prefixes
	var sortedPrefixes []string
	for p := range commonPrefixes {
		sortedPrefixes = append(sortedPrefixes, p)
	}
	sort.Strings(sortedPrefixes)

	return objects, sortedPrefixes, nil
}

// Helpers
func splitKey(key string) []string {
	parts := strings.Split(key, "/")
	var cleaned []string
	for _, part := range parts {
		if part != "" {
			cleaned = append(cleaned, part)
		}
	}
	return cleaned
}

func generateUUID() string {
	now := time.Now().UnixNano()
	return fmt.Sprintf("cl%x", now)
}
