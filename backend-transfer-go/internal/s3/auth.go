package s3

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
)

type S3Authenticator struct {
	database  *db.DB
	decryptor *crypto.S3Decryptor
}

func NewS3Authenticator(database *db.DB, decryptor *crypto.S3Decryptor) *S3Authenticator {
	return &S3Authenticator{
		database:  database,
		decryptor: decryptor,
	}
}

type ParsedAuth struct {
	AccessKeyID     string
	CredentialScope string
	SignedHeaders   []string
	Signature       string
	Date            string
	Region          string
	Service         string
}

func (a *S3Authenticator) Authenticate(c echo.Context) (string, error) {
	req := c.Request()
	authHeader := req.Header.Get("Authorization")

	if authHeader != "" && strings.HasPrefix(authHeader, "AWS4-HMAC-SHA256 ") {
		return a.authenticateHeader(c, authHeader)
	}

	return a.authenticatePresigned(c)
}

func (a *S3Authenticator) authenticateHeader(c echo.Context, authHeader string) (string, error) {
	req := c.Request()
	parsed := parseAuthHeader(authHeader)
	if parsed == nil {
		return "", errors.New("failed to parse Authorization header")
	}

	// Date skew check
	dateTime := req.Header.Get("x-amz-date")
	if dateTime == "" {
		dateTime = req.Header.Get("X-Amz-Date")
	}
	if len(dateTime) == 16 {
		reqTime, err := parseAmzDate(dateTime)
		if err == nil {
			skew := time.Since(reqTime)
			if skew < 0 {
				skew = -skew
			}
			if skew > 15*time.Minute {
				return "", fmt.Errorf("request timestamp too old (skew=%s)", skew)
			}
		}
	}

	// Look up S3Credential
	var credential db.S3Credential
	if err := a.database.Where("\"accessKeyId\" = ? AND \"isActive\" = ?", parsed.AccessKeyID, true).First(&credential).Error; err != nil {
		return "", fmt.Errorf("access key not found or inactive: %s", parsed.AccessKeyID)
	}

	secretKey, err := a.decryptor.DecryptSecret(credential.SecretAccessKey)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt secret access key: %v", err)
	}

	// Build canonical request
	canonicalReq := buildCanonicalRequest(req, parsed.SignedHeaders)
	h := sha256.New()
	h.Write([]byte(canonicalReq))
	canonicalReqHash := hex.EncodeToString(h.Sum(nil))

	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		dateTime,
		parsed.CredentialScope,
		canonicalReqHash,
	}, "\n")

	signingKey := deriveSigningKey(secretKey, parsed.Date, parsed.Region, parsed.Service)

	expectedSig := hmacSHA256(signingKey, []byte(stringToSign))

	if expectedSig != parsed.Signature {
		return "", errors.New("signature mismatch")
	}

	return credential.UserID, nil
}

func (a *S3Authenticator) authenticatePresigned(c echo.Context) (string, error) {
	req := c.Request()
	queryParams := req.URL.Query()

	algorithm := queryParams.Get("X-Amz-Algorithm")
	if algorithm != "AWS4-HMAC-SHA256" {
		return "", errors.New("missing or invalid authorization method")
	}

	credentialStr := queryParams.Get("X-Amz-Credential")
	dateTime := queryParams.Get("X-Amz-Date")
	expiresStr := queryParams.Get("X-Amz-Expires")
	signedHeadersStr := queryParams.Get("X-Amz-SignedHeaders")
	signature := queryParams.Get("X-Amz-Signature")

	if credentialStr == "" || dateTime == "" || expiresStr == "" || signedHeadersStr == "" || signature == "" {
		return "", errors.New("presigned URL missing required parameters")
	}

	credParts := strings.Split(credentialStr, "/")
	if len(credParts) < 5 {
		return "", errors.New("invalid credential format")
	}
	accessKeyID := credParts[0]
	date := credParts[1]
	region := credParts[2]
	service := credParts[3]
	credentialScope := strings.Join(credParts[1:], "/")

	expires, err := strconv.ParseInt(expiresStr, 10, 64)
	if err != nil || expires < 1 || expires > 604800 {
		return "", fmt.Errorf("invalid Expires value: %s", expiresStr)
	}

	if len(dateTime) != 16 {
		return "", errors.New("invalid X-Amz-Date format")
	}

	reqTime, err := parseAmzDate(dateTime)
	if err != nil {
		return "", fmt.Errorf("failed to parse X-Amz-Date: %v", err)
	}

	expirationTime := reqTime.Add(time.Duration(expires) * time.Second)
	if time.Now().After(expirationTime) {
		return "", errors.New("presigned URL has expired")
	}

	// Look up S3Credential
	var credential db.S3Credential
	if err := a.database.Where("\"accessKeyId\" = ? AND \"isActive\" = ?", accessKeyID, true).First(&credential).Error; err != nil {
		return "", fmt.Errorf("access key not found or inactive: %s", accessKeyID)
	}

	secretKey, err := a.decryptor.DecryptSecret(credential.SecretAccessKey)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt secret access key: %v", err)
	}

	signedHeaders := strings.Split(signedHeadersStr, ";")

	// Build canonical request for presigned
	canonicalReq := buildCanonicalRequestPresigned(req, signedHeaders)
	h := sha256.New()
	h.Write([]byte(canonicalReq))
	canonicalReqHash := hex.EncodeToString(h.Sum(nil))

	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		dateTime,
		credentialScope,
		canonicalReqHash,
	}, "\n")

	signingKey := deriveSigningKey(secretKey, date, region, service)

	expectedSig := hmacSHA256(signingKey, []byte(stringToSign))

	if expectedSig != signature {
		return "", errors.New("signature mismatch")
	}

	return credential.UserID, nil
}

func parseAuthHeader(authHeader string) *ParsedAuth {
	content := strings.TrimPrefix(authHeader, "AWS4-HMAC-SHA256 ")
	parts := make(map[string]string)

	re := regexp.MustCompile(`([^=,\s]+)\s*=\s*([^=,]+)`)
	matches := re.FindAllStringSubmatch(content, -1)
	for _, m := range matches {
		parts[m[1]] = strings.TrimSpace(m[2])
	}

	// Also backup split logic just in case the regex misses values with commas inside them (though credentials/signed headers are safe)
	credential := parts["Credential"]
	signedHeadersStr := parts["SignedHeaders"]
	signature := parts["Signature"]

	if credential == "" || signedHeadersStr == "" || signature == "" {
		// Try manual parsing as regex might be too strict
		for _, part := range strings.Split(content, ",") {
			part = strings.TrimSpace(part)
			eqIdx := strings.Index(part, "=")
			if eqIdx == -1 {
				continue
			}
			key := strings.TrimSpace(part[:eqIdx])
			val := strings.TrimSpace(part[eqIdx+1:])
			parts[key] = val
		}
		credential = parts["Credential"]
		signedHeadersStr = parts["SignedHeaders"]
		signature = parts["Signature"]
	}

	if credential == "" || signedHeadersStr == "" || signature == "" {
		return nil
	}

	credParts := strings.Split(credential, "/")
	if len(credParts) < 5 {
		return nil
	}

	return &ParsedAuth{
		AccessKeyID:     credParts[0],
		CredentialScope: strings.Join(credParts[1:], "/"),
		SignedHeaders:   strings.Split(signedHeadersStr, ";"),
		Signature:       signature,
		Date:            credParts[1],
		Region:          credParts[2],
		Service:         credParts[3],
	}
}

func parseAmzDate(dateTime string) (time.Time, error) {
	// Format: YYYYMMDDTHHMMSSZ -> 20060102T150405Z
	return time.Parse("20060102T150405Z", dateTime)
}

func getOriginalPath(req *http.Request) string {
	if req.RequestURI != "" {
		// RequestURI contains query string, so parse it
		if u, err := url.ParseRequestURI(req.RequestURI); err == nil {
			return u.EscapedPath()
		}
	}
	return req.URL.EscapedPath()
}

func buildCanonicalRequest(req *http.Request, signedHeaders []string) string {
	method := strings.ToUpper(req.Method)
	path := getOriginalPath(req)
	if path == "" {
		path = "/"
	}
	canonicalURI := buildCanonicalURI(path)
	canonicalQuery := buildCanonicalQueryString(req.URL.RawQuery, "")

	var headerLines []string
	for _, h := range signedHeaders {
		val := req.Header.Get(h)
		if val == "" {
			for k, v := range req.Header {
				if strings.ToLower(k) == strings.ToLower(h) {
					val = strings.Join(v, ",")
					break
				}
			}
		}
		headerLines = append(headerLines, fmt.Sprintf("%s:%s", strings.ToLower(h), normalizeHeaderValue(val)))
	}
	canonicalHeaders := strings.Join(headerLines, "\n") + "\n"
	signedHeadersStr := strings.Join(signedHeaders, ";")

	payloadHash := req.Header.Get("x-amz-content-sha256")
	if payloadHash == "" {
		payloadHash = req.Header.Get("X-Amz-Content-Sha256")
	}
	if payloadHash == "" {
		payloadHash = "UNSIGNED-PAYLOAD"
	}

	return strings.Join([]string{
		method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders,
		signedHeadersStr,
		payloadHash,
	}, "\n")
}

func buildCanonicalRequestPresigned(req *http.Request, signedHeaders []string) string {
	method := strings.ToUpper(req.Method)
	path := getOriginalPath(req)
	if path == "" {
		path = "/"
	}
	canonicalURI := buildCanonicalURI(path)
	canonicalQuery := buildCanonicalQueryString(req.URL.RawQuery, "X-Amz-Signature")

	var headerLines []string
	for _, h := range signedHeaders {
		val := req.Header.Get(h)
		if val == "" {
			for k, v := range req.Header {
				if strings.ToLower(k) == strings.ToLower(h) {
					val = strings.Join(v, ",")
					break
				}
			}
		}
		headerLines = append(headerLines, fmt.Sprintf("%s:%s", strings.ToLower(h), normalizeHeaderValue(val)))
	}
	canonicalHeaders := strings.Join(headerLines, "\n") + "\n"
	signedHeadersStr := strings.Join(signedHeaders, ";")

	return strings.Join([]string{
		method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders,
		signedHeadersStr,
		"UNSIGNED-PAYLOAD",
	}, "\n")
}

func deriveSigningKey(secretKey, date, region, service string) []byte {
	kDate := hmacSHA256Hash([]byte("AWS4"+secretKey), []byte(date))
	kRegion := hmacSHA256Hash(kDate, []byte(region))
	kService := hmacSHA256Hash(kRegion, []byte(service))
	kSigning := hmacSHA256Hash(kService, []byte("aws4_request"))
	return kSigning
}

func hmacSHA256Hash(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func hmacSHA256(key, data []byte) string {
	return hex.EncodeToString(hmacSHA256Hash(key, data))
}

func normalizeHeaderValue(val string) string {
	return strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(val, " "))
}

func buildCanonicalURI(rawPath string) string {
	segments := strings.Split(rawPath, "/")
	var encoded []string
	for _, segment := range segments {
		decoded, err := url.PathUnescape(segment)
		if err != nil {
			decoded = segment
		}
		encoded = append(encoded, awsURIEncode(decoded))
	}
	return strings.Join(encoded, "/")
}

func buildCanonicalQueryString(rawQuery string, excludeKey string) string {
	if rawQuery == "" {
		return ""
	}

	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return ""
	}

	var keys []string
	for k := range values {
		if k != excludeKey {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	var queryParts []string
	for _, k := range keys {
		escapedKey := awsURIEncode(k)
		vals := values[k]
		sort.Strings(vals)
		for _, val := range vals {
			escapedVal := awsURIEncode(val)
			queryParts = append(queryParts, fmt.Sprintf("%s=%s", escapedKey, escapedVal))
		}
	}

	return strings.Join(queryParts, "&")
}

func awsURIEncode(s string) string {
	escaped := url.QueryEscape(s)
	escaped = strings.ReplaceAll(escaped, "+", "%20")
	escaped = strings.ReplaceAll(escaped, "*", "%2A")
	return escaped
}
