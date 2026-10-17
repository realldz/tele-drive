package telegram

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/settings"
)

// The golden hash was produced by transferCacheETag('f1', 120) on the NestJS
// side (backend/src/common/transfer-cache.util.spec.ts). Both backends must
// keep emitting the SAME ETag for the same (fileId, size) — a CDN may hold an
// entry fetched from either side and revalidate against the other.
const goldenNestJSFingerprint = "90b2981ae4beec2aa50345bcab45361a"

func TestTransferCacheETagMatchesNestJS(t *testing.T) {
	want := fmt.Sprintf(`"td-%s"`, goldenNestJSFingerprint)
	if got := transferCacheETag("f1", 120); got != want {
		t.Fatalf("transferCacheETag = %q, want %q (NestJS mirror drift — update BOTH sides together)", got, want)
	}
}

func TestIfNoneMatchSatisfied(t *testing.T) {
	etag := `"td-90b2981ae4beec2aa50345bcab45361a"`
	cases := []struct {
		name   string
		header string
		want   bool
	}{
		{"exact", etag, true},
		{"weak prefix", `W/` + etag, true},
		{"list", `"aaaa", ` + etag, true},
		{"wildcard", "*", true},
		{"mismatch", `"aaaa"`, false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		if got := ifNoneMatchSatisfied(tc.header, etag); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestApplyCacheHeadersPolicies(t *testing.T) {
	etag := `"td-90b2981ae4beec2aa50345bcab45361a"`
	cases := []struct {
		name string
		// enabled governs the synthetic settings snapshot wired below
		enabled bool
		scope   DownloadCacheScope
		inm     string
		wantCC  string
		want304 bool
	}{
		{"private always no-store", true, CacheScopePrivate, "", "private, no-store", false},
		{"signed disabled noop no-store", false, CacheScopeSigned, "", "private, no-store", false},
		{"signed enabled public", true, CacheScopeSigned, "", "public, max-age=3600", false},
		{"revalidation 304", true, CacheScopeSigned, etag, "public, max-age=3600", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &Downloader{}
			d.settingsResolver = newCdnFakeResolver(tc.enabled)

			rec := httptest.NewRecorder()
			shortCircuited := d.ApplyCacheHeaders(
				t.Context(),
				rec,
				tc.scope,
				"f1",
				120,
				tc.inm,
			)

			if got := rec.Header().Get("Cache-Control"); got != tc.wantCC {
				t.Errorf("Cache-Control = %q, want %q", got, tc.wantCC)
			}
			if got := rec.Header().Get("ETag"); got != etag {
				t.Errorf("ETag = %q, want %q", got, etag)
			}
			if shortCircuited != tc.want304 {
				t.Errorf("shortCircuited = %v, want %v", shortCircuited, tc.want304)
			}
		})
	}
}

func TestApplyCacheHeadersSkipsS3Scope(t *testing.T) {
	d := &Downloader{}
	d.settingsResolver = newCdnFakeResolver(true)

	rec := httptest.NewRecorder()
	shortCircuited := d.ApplyCacheHeaders(
		t.Context(),
		rec,
		CacheScopeNone,
		"f1",
		120,
		"",
	)

	if shortCircuited {
		t.Fatal("none scope must never short-circuit")
	}
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Errorf("none scope must not set Cache-Control, got %q", got)
	}
	if got := rec.Header().Get("ETag"); got != "" {
		t.Errorf("none scope must not set an ETag, got %q", got)
	}
}

func TestClampCacheTTL(t *testing.T) {
	if got := clampCacheTTL(0); got != cacheDefaultTTL {
		t.Errorf("clampCacheTTL(0) = %d, want %d", got, cacheDefaultTTL)
	}
	if got := clampCacheTTL(5); got != cacheMinTTL {
		t.Errorf("clampCacheTTL(5) = %d, want %d", got, cacheMinTTL)
	}
	if got := clampCacheTTL(9_999_999); got != cacheMaxTTL {
		t.Errorf("clampCacheTTL(9999999) = %d, want %d", got, cacheMaxTTL)
	}
}

// cdnFakeFetcher satisfies settings.settingsFetcher from the test package side.
type cdnFakeFetcher struct {
	enabled bool
}

func (f *cdnFakeFetcher) GetSystemSettings(_ context.Context, _ []string) (map[string]string, error) {
	out := map[string]string{}
	if f.enabled {
		out["CDN_CACHE_ENABLED"] = "true"
	}
	return out, nil
}

func newCdnFakeResolver(enabled bool) *settings.Resolver {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return settings.NewResolver(&cdnFakeFetcher{enabled: enabled}, logger)
}
