package handler

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

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
// GET is implemented in Phase 5; HEAD (Phase 7) and PUT (Phase 6) are wired in
// their respective phases.
func (h *FileHandler) RegisterS3Routes(e *echo.Echo) {
	s3 := e.Group("", h.s3HostFilter)
	s3.GET("/:bucket/*", h.S3GetObject)
}
