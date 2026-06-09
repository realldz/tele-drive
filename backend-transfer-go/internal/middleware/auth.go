package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

type JWTClaims struct {
	Sub      string `json:"sub"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Exp      int64  `json:"exp"`
}

func ParseJWT(tokenStr string, secret string) (*JWTClaims, error) {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid token format")
	}

	headerSegment := parts[0]
	payloadSegment := parts[1]
	signatureSegment := parts[2]

	// Verify signature
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(headerSegment + "." + payloadSegment))
	expectedSig := mac.Sum(nil)

	// Base64Url decode helper
	decodeBase64Url := func(s string) ([]byte, error) {
		// pad first if needed
		if l := len(s) % 4; l > 0 {
			s += strings.Repeat("=", 4-l)
		}
		// Try raw first
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err == nil {
			return b, nil
		}
		// Try standard url
		b, err = base64.URLEncoding.DecodeString(s)
		if err == nil {
			return b, nil
		}
		// Try raw std
		b, err = base64.RawStdEncoding.DecodeString(s)
		if err == nil {
			return b, nil
		}
		return base64.StdEncoding.DecodeString(s)
	}

	sig, err := decodeBase64Url(signatureSegment)
	if err != nil {
		return nil, err
	}

	if !hmac.Equal(sig, expectedSig) {
		return nil, errors.New("signature verification failed")
	}

	payloadBytes, err := decodeBase64Url(payloadSegment)
	if err != nil {
		return nil, err
	}

	var claims JWTClaims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, err
	}

	if claims.Exp > 0 && time.Now().Unix() > claims.Exp {
		return nil, errors.New("token expired")
	}

	return &claims, nil
}

// JWTMiddleware requires valid JWT
func JWTMiddleware(jwtSecret string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token := extractToken(c)
			if token == "" {
				return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
			}

			claims, err := ParseJWT(token, jwtSecret)
			if err != nil {
				return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Unauthorized: " + err.Error()})
			}

			c.Set("userId", claims.Sub)
			c.Set("username", claims.Username)
			c.Set("role", claims.Role)
			return next(c)
		}
	}
}

// OptionalJWTMiddleware parses JWT if present, otherwise continues
func OptionalJWTMiddleware(jwtSecret string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token := extractToken(c)
			if token != "" {
				claims, err := ParseJWT(token, jwtSecret)
				if err == nil {
					c.Set("userId", claims.Sub)
					c.Set("username", claims.Username)
					c.Set("role", claims.Role)
				}
			}
			return next(c)
		}
	}
}

func extractToken(c echo.Context) string {
	auth := c.Request().Header.Get("Authorization")
	if auth != "" && strings.HasPrefix(auth, "Bearer ") {
		return auth[7:]
	}
	return c.QueryParam("token")
}
