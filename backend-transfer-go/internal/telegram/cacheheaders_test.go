package telegram

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
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

func TestApplyCacheHeadersModes(t *testing.T) {
	etag := `"td-90b2981ae4beec2aa50345bcab45361a"`
	cases := []struct {
		name    string
		mode    DownloadCacheMode
		scope   DownloadCacheScope
		inm     string
		wantCC  string
		want304 bool
	}{
		{"disabled signed", CacheModeDisabled, CacheScopeSigned, "", "private, no-store", false},
		{"disabled private", CacheModeDisabled, CacheScopePrivate, "", "private, no-store", false},
		{"revalidate signed", CacheModeRevalidate, CacheScopeSigned, "", "no-cache", false},
		{"revalidate private bypass", CacheModeRevalidate, CacheScopePrivate, "", "private, no-store", false},
		{"full signed", CacheModeFull, CacheScopeSigned, "", "public, max-age=3600", false},
		{"full private bypass", CacheModeFull, CacheScopePrivate, "", "private, no-store", false},
		{"revalidate 304", CacheModeRevalidate, CacheScopeSigned, etag, "no-cache", true},
		{"degenerate mode → disabled", DownloadCacheMode("bogus"), CacheScopeSigned, "", "private, no-store", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &Downloader{}
			d.settingsResolver = newCdnFakeWindowResolver(tc.mode, 0)

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
	d.settingsResolver = newCdnFakeWindowResolver(CacheModeFull, 0)

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

func TestQuantizeTokenExp(t *testing.T) {
	// window=1000, mode full → ceiling bucket.
	d := &Downloader{}
	d.settingsResolver = newCdnFakeWindowResolver(CacheModeFull, 1000)
	if got := d.QuantizeTokenExp(t.Context(), 1999); got != 2000 {
		t.Errorf("got %d, want 2000", got)
	}
	if got := d.QuantizeTokenExp(t.Context(), 2000); got != 2000 {
		t.Errorf("exact boundary: got %d, want 2000", got)
	}

	// window=0 → off.
	d2 := &Downloader{}
	d2.settingsResolver = newCdnFakeWindowResolver(CacheModeFull, 0)
	if got := d2.QuantizeTokenExp(t.Context(), 1999); got != 1999 {
		t.Errorf("window=0: got %d, want raw exp 1999", got)
	}

	// mode disabled → off even with a window.
	d3 := &Downloader{}
	d3.settingsResolver = newCdnFakeWindowResolver(CacheModeDisabled, 1000)
	if got := d3.QuantizeTokenExp(t.Context(), 1999); got != 1999 {
		t.Errorf("disabled mode: got %d, want raw exp", got)
	}

	// revalidate mode honors the window too.
	d4 := &Downloader{}
	d4.settingsResolver = newCdnFakeWindowResolver(CacheModeRevalidate, 1000)
	if got := d4.QuantizeTokenExp(t.Context(), 1); got != 1000 {
		t.Errorf("revalidate: got %d, want 1000", got)
	}

	// no resolver → off.
	plain := &Downloader{}
	if got := plain.QuantizeTokenExp(t.Context(), 1999); got != 1999 {
		t.Errorf("nil resolver: got %d, want raw exp", got)
	}
}

// cdnFakeWindowFetcher satisfies settings.settingsFetcher from the test
// package side, exposing CDN_CACHE_MODE and CDN_CACHE_WINDOW_SECONDS.
type cdnFakeWindowFetcher struct {
	mode   DownloadCacheMode
	window int
}

func (f *cdnFakeWindowFetcher) GetSystemSettings(_ context.Context, _ []string) (map[string]string, error) {
	out := map[string]string{}
	if f.mode != CacheModeDisabled {
		out[string(cacheModeSettingKey)] = string(f.mode)
	}
	out["CDN_CACHE_WINDOW_SECONDS"] = strconv.Itoa(f.window)
	return out, nil
}

func newCdnFakeWindowResolver(mode DownloadCacheMode, window int) *settings.Resolver {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return settings.NewResolver(&cdnFakeWindowFetcher{mode: mode, window: window}, logger)
}
