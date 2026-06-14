// Package s3auth — credential resolution layer for the SigV4 verifier.
//
// CredentialResolver implements the verifier's CredentialLookup interface with
// a Redis-first, gRPC-fallback strategy:
//
//	Redis GET s3:cred:{accessKeyId}
//	  ├─ HIT (active)    → return secret + userId
//	  ├─ HIT (tombstone) → return ErrCredentialNotFound
//	  └─ MISS            → singleflight gRPC GetS3Credential → populate cache
//
// NestJS owns the source of truth (Postgres S3Credential) and writes the cache
// through on create/update, DELeting on revoke. The TTL bounds staleness for
// the rare case where a write-through is missed.
package s3auth

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// credentialFetcher is the slice of the gRPC CoreClient this resolver needs.
// Declaring it as an interface keeps the resolver unit-testable with a fake
// (no live gRPC connection) — *grpc.CoreClient satisfies it directly.
type credentialFetcher interface {
	GetS3Credential(ctx context.Context, accessKeyID string) (*pb.GetS3CredentialResponse, error)
}

const (
	// credCacheKeyPrefix namespaces credential cache entries in Redis. NestJS
	// write-through uses the identical prefix.
	credCacheKeyPrefix = "s3:cred:"
	// credActiveTTL keeps a valid credential cached long enough to avoid
	// hammering NestJS, short enough that a missed revoke self-heals.
	credActiveTTL = 15 * time.Minute
	// credTombstoneTTL caches negative lookups briefly so a client spamming a
	// revoked/unknown key does not generate a gRPC call per request.
	credTombstoneTTL = 60 * time.Second
)

// CachedCredential is the Redis-serialized credential record. JSON field names
// match the NestJS write-through payload exactly (camelCase) so either service
// can read what the other wrote.
type CachedCredential struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	UserID          string `json:"userId"`
	IsActive        bool   `json:"isActive"`
	// Found distinguishes a tombstone (Found=false, unknown/revoked key) from a
	// real cached credential. Tombstones omit secret/userId.
	Found bool `json:"found"`
}

// CredentialResolver resolves accessKeyId → credential with Redis caching and a
// singleflight-guarded gRPC fallback. Implements CredentialLookup.
type CredentialResolver struct {
	rdb     *redis.Client
	core    credentialFetcher
	logger  *slog.Logger
	sfGroup singleflight.Group
}

// NewCredentialResolver builds a resolver. The logger must be non-nil.
// core is typically a *grpc.CoreClient (satisfies credentialFetcher).
func NewCredentialResolver(rdb *redis.Client, core credentialFetcher, logger *slog.Logger) *CredentialResolver {
	return &CredentialResolver{rdb: rdb, core: core, logger: logger}
}

// Get implements CredentialLookup. Returns ErrCredentialNotFound for unknown or
// tombstoned keys; (secret, userId, true, nil) for active credentials; and
// (.., false, nil) for credentials that exist but are deactivated (the verifier
// logs + rejects inactive).
func (r *CredentialResolver) Get(ctx context.Context, accessKeyID string) (secret string, userID string, active bool, err error) {
	reqID, _ := ctx.Value(requestIDKey).(string)

	if cred, ok := r.readCache(ctx, accessKeyID, reqID); ok {
		if !cred.Found {
			return "", "", false, ErrCredentialNotFound
		}
		return cred.SecretAccessKey, cred.UserID, cred.IsActive, nil
	}

	// Collapse concurrent misses for the same key into one gRPC call.
	v, ferr, shared := r.sfGroup.Do(accessKeyID, func() (interface{}, error) {
		return r.fetchFromCore(ctx, accessKeyID, reqID)
	})
	if shared {
		r.logger.Debug("s3auth.cred.singleflight.shared", "accessKeyId", accessKeyID, "requestId", reqID)
	}
	if ferr != nil {
		return "", "", false, ferr
	}

	cred := v.(*CachedCredential)
	if !cred.Found {
		return "", "", false, ErrCredentialNotFound
	}
	return cred.SecretAccessKey, cred.UserID, cred.IsActive, nil
}

// readCache returns (credential, true) on any cache hit (including tombstone),
// or (nil, false) on miss / unusable entry so the caller falls through to gRPC.
func (r *CredentialResolver) readCache(ctx context.Context, accessKeyID, reqID string) (*CachedCredential, bool) {
	raw, err := r.rdb.Get(ctx, credCacheKeyPrefix+accessKeyID).Result()
	if err == redis.Nil {
		return nil, false
	}
	if err != nil {
		r.logger.Error("s3auth.cred.cache.redis_error",
			"accessKeyId", accessKeyID, "error", err.Error(), "requestId", reqID)
		return nil, false
	}

	var cred CachedCredential
	if jerr := json.Unmarshal([]byte(raw), &cred); jerr != nil {
		r.logger.Warn("s3auth.cred.cache.corrupt",
			"accessKeyId", accessKeyID, "error", jerr.Error(), "requestId", reqID)
		return nil, false
	}

	if !cred.Found {
		r.logger.Debug("s3auth.cred.cache.hit_tombstone",
			"accessKeyId", accessKeyID, "requestId", reqID)
	} else {
		r.logger.Debug("s3auth.cred.cache.hit",
			"accessKeyId", accessKeyID, "userId", cred.UserID, "isActive", cred.IsActive, "requestId", reqID)
	}
	return &cred, true
}

// fetchFromCore retrieves the credential from NestJS over gRPC and populates the
// cache. NestJS returns Found=false (not a gRPC NotFound status) for unknown
// keys, so we inspect the response flag, not status.Code.
func (r *CredentialResolver) fetchFromCore(ctx context.Context, accessKeyID, reqID string) (*CachedCredential, error) {
	r.logger.Info("s3auth.cred.cache.miss", "accessKeyId", accessKeyID, "requestId", reqID)

	resp, err := r.core.GetS3Credential(ctx, accessKeyID)
	if err != nil {
		r.logger.Error("s3auth.cred.grpc.error",
			"accessKeyId", accessKeyID, "error", err.Error(), "requestId", reqID)
		return nil, err
	}

	if !resp.Found {
		tomb := &CachedCredential{AccessKeyID: accessKeyID, Found: false}
		r.writeCache(ctx, tomb, credTombstoneTTL, reqID)
		r.logger.Warn("s3auth.cred.grpc.not_found",
			"accessKeyId", accessKeyID, "requestId", reqID)
		return tomb, nil
	}

	cred := &CachedCredential{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: resp.SecretAccessKey,
		UserID:          resp.UserId,
		IsActive:        resp.IsActive,
		Found:           true,
	}
	r.writeCache(ctx, cred, credActiveTTL, reqID)
	r.logger.Info("s3auth.cred.grpc.fetched",
		"accessKeyId", accessKeyID, "userId", cred.UserID, "isActive", cred.IsActive,
		"ttlSec", int(credActiveTTL.Seconds()), "requestId", reqID)
	return cred, nil
}

// writeCache serializes and stores a credential entry with the given TTL. Cache
// write failures are logged but non-fatal — the credential is still returned.
func (r *CredentialResolver) writeCache(ctx context.Context, cred *CachedCredential, ttl time.Duration, reqID string) {
	payload, err := json.Marshal(cred)
	if err != nil {
		r.logger.Error("s3auth.cred.cache.marshal_error",
			"accessKeyId", cred.AccessKeyID, "error", err.Error(), "requestId", reqID)
		return
	}
	if err := r.rdb.Set(ctx, credCacheKeyPrefix+cred.AccessKeyID, payload, ttl).Err(); err != nil {
		r.logger.Error("s3auth.cred.cache.write_error",
			"accessKeyId", cred.AccessKeyID, "error", err.Error(), "requestId", reqID)
	}
}
