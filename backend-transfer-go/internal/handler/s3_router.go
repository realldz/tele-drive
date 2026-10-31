package handler

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

const s3PrivateCacheControl = "private, no-store"

// s3PrivateNoStore prevents browsers and shared CDNs from caching authenticated
// S3 responses. In particular, a CDN cache-miss must not normalize a signed
// Range request before SigV4 verification at the origin.
func s3PrivateNoStore(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		headers := c.Response().Header()
		headers.Set("Cache-Control", s3PrivateCacheControl)
		headers.Set("CDN-Cache-Control", "no-store")
		headers.Set("Cloudflare-CDN-Cache-Control", "no-store")
		return next(c)
	}
}

// s3HostFilter rejects requests whose Host does not match the configured S3
// domain. Defense-in-depth: nginx (Phase 8) routes only S3 traffic to these
// root-level routes, but this guard ensures a stray request on another host
// can't trigger the S3 data plane. Empty s3Domain disables the filter (dev).
func (h *FileHandler) s3HostFilter(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if h.s3Domain == "" {
			return next(c)
		}
		// Host may carry a port (host:443) — compare the hostname only.
		host := c.Request().Host
		if i := strings.IndexByte(host, ':'); i != -1 {
			host = host[:i]
		}
		if !strings.EqualFold(host, h.s3Domain) {
			return c.NoContent(http.StatusNotFound)
		}
		return next(c)
	}
}

// RegisterS3Routes mounts the S3 data-plane routes at the root path, gated by
// the host filter. These replace the NestJS 307-redirect handlers for the S3
// object data plane. Control-plane ops (bucket CRUD, ListObjects, multipart
// orchestration) still go to NestJS via nginx routing (Phase 8).
//
// GET (Phase 5), PUT (Phase 6), and HEAD (Phase 7) are wired here.
func (h *FileHandler) RegisterS3Routes(e *echo.Echo) {
	s3 := e.Group("", s3PrivateNoStore, h.s3HostFilter)
	s3.GET("/:bucket/*", h.S3GetObject)
	s3.HEAD("/:bucket/*", h.S3HeadObject)
	s3.PUT("/:bucket/*", h.S3PutObject)
}
