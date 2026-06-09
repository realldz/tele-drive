package db

import (
	"strconv"
	"sync"
	"time"
)

type CachedValue struct {
	value  interface{}
	expiry time.Time
}

type SettingsCache struct {
	db    *DB
	mu    sync.RWMutex
	cache map[string]CachedValue
	ttl   time.Duration
}

func NewSettingsCache(db *DB) *SettingsCache {
	return &SettingsCache{
		db:    db,
		cache: make(map[string]CachedValue),
		ttl:   5 * time.Minute,
	}
}

func (s *SettingsCache) GetCachedSetting(key string, defaultValue interface{}, parser func(string) (interface{}, error)) interface{} {
	s.mu.RLock()
	cached, ok := s.cache[key]
	if ok && time.Now().Before(cached.expiry) {
		val := cached.value
		s.mu.RUnlock()
		return val
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()

	// Double check
	cached, ok = s.cache[key]
	if ok && time.Now().Before(cached.expiry) {
		return cached.value
	}

	var setting SystemSetting
	err := s.db.Where("key = ?", key).First(&setting).Error
	var finalVal interface{} = defaultValue
	if err == nil {
		if parser != nil {
			parsed, parseErr := parser(setting.Value)
			if parseErr == nil {
				finalVal = parsed
			}
		} else {
			finalVal = setting.Value
		}
	}

	s.cache[key] = CachedValue{
		value:  finalVal,
		expiry: time.Now().Add(s.ttl),
	}

	return finalVal
}

func (s *SettingsCache) GetCachedSettingInt(key string, defaultValue int) int {
	val := s.GetCachedSetting(key, defaultValue, func(str string) (interface{}, error) {
		i, err := strconv.Atoi(str)
		if err != nil {
			return nil, err
		}
		return i, nil
	})
	if i, ok := val.(int); ok {
		return i
	}
	return defaultValue
}

func (s *SettingsCache) GetCachedSettingInt64(key string, defaultValue int64) int64 {
	val := s.GetCachedSetting(key, defaultValue, func(str string) (interface{}, error) {
		i, err := strconv.ParseInt(str, 10, 64)
		if err != nil {
			return nil, err
		}
		return i, nil
	})
	if i, ok := val.(int64); ok {
		return i
	}
	return defaultValue
}

func (s *SettingsCache) GetCachedSettingBool(key string, defaultValue bool) bool {
	val := s.GetCachedSetting(key, defaultValue, func(str string) (interface{}, error) {
		return str != "false", nil
	})
	if b, ok := val.(bool); ok {
		return b
	}
	return defaultValue
}

func (s *SettingsCache) GetCachedSettingString(key string, defaultValue string) string {
	val := s.GetCachedSetting(key, defaultValue, nil)
	if str, ok := val.(string); ok {
		return str
	}
	return defaultValue
}

func (s *SettingsCache) Invalidate(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cache, key)
}
