package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestS3PrivateNoStore(t *testing.T) {
	e := echo.New()
	e.GET("/bucket/key", func(c echo.Context) error {
		return c.NoContent(http.StatusOK)
	}, s3PrivateNoStore)

	req := httptest.NewRequest(http.MethodGet, "/bucket/key", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want %q", got, "private, no-store")
	}
	if got := rec.Header().Get("CDN-Cache-Control"); got != "no-store" {
		t.Fatalf("CDN-Cache-Control = %q, want %q", got, "no-store")
	}
	if got := rec.Header().Get("Cloudflare-CDN-Cache-Control"); got != "no-store" {
		t.Fatalf("Cloudflare-CDN-Cache-Control = %q, want %q", got, "no-store")
	}
}
