package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/middleware"
)

func TestGenerateUniqueName(t *testing.T) {
	tests := []struct {
		name          string
		existingNames []string
		expected      string
	}{
		{
			name:          "test.txt",
			existingNames: []string{"test.txt", "foo.txt"},
			expected:      "test (1).txt",
		},
		{
			name:          "test.txt",
			existingNames: []string{"test.txt", "test (1).txt"},
			expected:      "test (2).txt",
		},
		{
			name:          "test",
			existingNames: []string{"test", "test (1)", "test (2)"},
			expected:      "test (3)",
		},
		{
			name:          "unique.txt",
			existingNames: []string{"test.txt", "foo.txt"},
			expected:      "unique.txt",
		},
	}

	for _, tt := range tests {
		got := GenerateUniqueName(tt.name, tt.existingNames)
		if got != tt.expected {
			t.Errorf("GenerateUniqueName(%q, %v) = %q, expected %q", tt.name, tt.existingNames, got, tt.expected)
		}
	}
}

func TestJWTMiddleware(t *testing.T) {
	e := echo.New()
	jwtSecret := "my-very-secret-key-32-chars-long-!"

	// Create a valid token
	tokenStr, err := makeTestToken("user-123", "john_doe", "user", jwtSecret)
	if err != nil {
		t.Fatalf("failed to make test token: %v", err)
	}

	handler := middleware.JWTMiddleware(jwtSecret)(func(c echo.Context) error {
		userID := c.Get("userId").(string)
		username := c.Get("username").(string)
		role := c.Get("role").(string)

		return c.JSON(http.StatusOK, map[string]string{
			"userId":   userID,
			"username": username,
			"role":     role,
		})
	})

	// 1. Success case with Bearer Authorization header
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler(c); err != nil {
		t.Fatalf("unexpected handler error: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var res map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("failed to parse body: %v", err)
	}

	if res["userId"] != "user-123" || res["username"] != "john_doe" || res["role"] != "user" {
		t.Errorf("mismatch in decoded context claims: %+v", res)
	}

	// 2. Failure case with missing token
	reqNoAuth := httptest.NewRequest(http.MethodGet, "/", nil)
	recNoAuth := httptest.NewRecorder()
	cNoAuth := e.NewContext(reqNoAuth, recNoAuth)

	_ = handler(cNoAuth)
	if recNoAuth.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 on missing auth, got %d", recNoAuth.Code)
	}
}

func TestOptionalJWTMiddleware(t *testing.T) {
	e := echo.New()
	jwtSecret := "my-very-secret-key-32-chars-long-!"

	handler := middleware.OptionalJWTMiddleware(jwtSecret)(func(c echo.Context) error {
		userID, _ := c.Get("userId").(string)
		return c.JSON(http.StatusOK, map[string]string{
			"userId": userID,
		})
	})

	// 1. Case with token
	tokenStr, _ := makeTestToken("user-789", "alice", "admin", jwtSecret)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	_ = handler(c)
	var res map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res["userId"] != "user-789" {
		t.Errorf("expected userId user-789, got %q", res["userId"])
	}

	// 2. Case without token (should succeed with empty userId)
	reqGuest := httptest.NewRequest(http.MethodGet, "/", nil)
	recGuest := httptest.NewRecorder()
	cGuest := e.NewContext(reqGuest, recGuest)

	_ = handler(cGuest)
	var resGuest map[string]string
	_ = json.Unmarshal(recGuest.Body.Bytes(), &resGuest)
	if resGuest["userId"] != "" {
		t.Errorf("expected empty userId, got %q", resGuest["userId"])
	}
}

// Helpers for signing JWT token manually to avoid external jwt dependency in testing
func makeTestToken(sub, username, role, secret string) (string, error) {
	header := `{"alg":"HS256","typ":"JWT"}`
	claims := map[string]interface{}{
		"sub":      sub,
		"username": username,
		"role":     role,
		"exp":      0, // no expiration
	}
	claimsBytes, _ := json.Marshal(claims)

	base64url := func(data []byte) string {
		var encoding = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
		var buf []byte
		var l = len(data)
		for i := 0; i < l; i += 3 {
			var remaining = l - i
			var b1 = data[i]
			var b2 byte = 0
			var b3 byte = 0
			if remaining > 1 {
				b2 = data[i+1]
			}
			if remaining > 2 {
				b3 = data[i+2]
			}

			var val = (uint32(b1) << 16) | (uint32(b2) << 8) | uint32(b3)
			buf = append(buf, encoding[(val>>18)&63])
			buf = append(buf, encoding[(val>>12)&63])
			if remaining > 1 {
				buf = append(buf, encoding[(val>>6)&63])
			}
			if remaining > 2 {
				buf = append(buf, encoding[val&63])
			}
		}
		return string(buf)
	}

	hSegment := base64url([]byte(header))
	pSegment := base64url(claimsBytes)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(hSegment + "." + pSegment))
	sigBytes := mac.Sum(nil)
	sSegment := base64url(sigBytes)

	return hSegment + "." + pSegment + "." + sSegment, nil
}
