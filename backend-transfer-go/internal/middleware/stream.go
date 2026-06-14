package middleware

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
)

func StreamCookieMiddleware(cryptoEngine *crypto.CryptoEngine) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			cookie, err := c.Cookie("stream_token")
			if err != nil || cookie.Value == "" {
				return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Stream cookie required"})
			}

			payload, err := cryptoEngine.VerifyStreamCookieToken(cookie.Value)
			if err != nil {
				return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Invalid or expired stream cookie"})
			}

			c.Set("streamUserSubject", payload.Sub)
			return next(c)
		}
	}
}
