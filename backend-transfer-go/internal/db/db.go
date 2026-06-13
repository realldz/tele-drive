package db

import (
	"github.com/redis/go-redis/v9"
)

func ConnectRedis(url string) (*redis.Client, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}

	rdb := redis.NewClient(opts)
	return rdb, nil
}
