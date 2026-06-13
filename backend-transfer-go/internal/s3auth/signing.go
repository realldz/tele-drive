package s3auth

import (
	"crypto/hmac"
	"crypto/sha256"
)

// deriveSigningKey computes the AWS SigV4 signing key:
//
//	kDate    = HMAC-SHA256("AWS4"+secretAccessKey, date)
//	kRegion  = HMAC-SHA256(kDate, region)
//	kService = HMAC-SHA256(kRegion, service)
//	kSigning = HMAC-SHA256(kService, "aws4_request")
//
// All inputs are treated as UTF-8 byte sequences.
func deriveSigningKey(secretAccessKey, date, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretAccessKey), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	return kSigning
}

// ComputeSignature returns the hex-encoded HMAC-SHA256 of stringToSign
// using the provided signing key. The hex output matches AWS's lowercase format.
func ComputeSignature(signingKey []byte, stringToSign string) string {
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(stringToSign))
	return toHex(mac.Sum(nil))
}

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

const hexDigits = "0123456789abcdef"

func toHex(b []byte) string {
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexDigits[c>>4]
		out[i*2+1] = hexDigits[c&0x0f]
	}
	return string(out)
}

// SHA256Hex returns the lowercase hex SHA-256 of data.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return toHex(sum[:])
}
