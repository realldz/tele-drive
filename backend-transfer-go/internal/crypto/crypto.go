package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type CryptoEngine struct {
	masterSecret []byte
}

type SignedTokenPayload struct {
	FID string `json:"fid"`
	Exp int64  `json:"exp"`
	T   string `json:"t"` // "u", "s", "sf"
	UID string `json:"uid,omitempty"`
	Sig string `json:"sig"`
}

type StreamCookiePayload struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
	Sig string `json:"sig"`
}

func NewCryptoEngine(masterSecret string) (*CryptoEngine, error) {
	if len(masterSecret) != 32 {
		return nil, errors.New("MASTER_SECRET must be exactly 32 bytes long for AES-256")
	}
	return &CryptoEngine{
		masterSecret: []byte(masterSecret),
	}, nil
}

// GenerateFileKey generates a random 32-byte key (DEK)
func (e *CryptoEngine) GenerateFileKey() ([]byte, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, nil
}

// GenerateIv generates a random 16-byte IV
func (e *CryptoEngine) GenerateIv() ([]byte, error) {
	iv := make([]byte, 16)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	return iv, nil
}

// EncryptKey encrypts the DEK with the MASTER_SECRET using AES-256-CTR
// Must match the NestJS CryptoService.encryptKey for backward compatibility
func (e *CryptoEngine) EncryptKey(dek []byte) (string, error) {
	iv, err := e.GenerateIv()
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(e.masterSecret)
	if err != nil {
		return "", err
	}

	stream := cipher.NewCTR(block, iv)
	encrypted := make([]byte, len(dek))
	stream.XORKeyStream(encrypted, dek)

	return fmt.Sprintf("%s:%s", hex.EncodeToString(iv), hex.EncodeToString(encrypted)), nil
}

// DecryptKey decrypts the DEK using the MASTER_SECRET and AES-256-CTR
// Must match the NestJS CryptoService.decryptKey for backward compatibility
func (e *CryptoEngine) DecryptKey(encryptedKey string) ([]byte, error) {
	parts := strings.Split(encryptedKey, ":")
	if len(parts) != 2 {
		return nil, errors.New("invalid encrypted key format")
	}

	iv, err := hex.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}

	encrypted, err := hex.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(e.masterSecret)
	if err != nil {
		return nil, err
	}

	stream := cipher.NewCTR(block, iv)
	decrypted := make([]byte, len(encrypted))
	stream.XORKeyStream(decrypted, encrypted)

	return decrypted, nil
}

// DecryptStreamWithOffset wraps an io.Reader and returns a decrypted stream supporting Range offset seeking
func (e *CryptoEngine) DecryptStreamWithOffset(r io.Reader, dek, iv []byte, byteOffset int64) (io.Reader, error) {
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}

	blockIndex := byteOffset / 16
	bytesToDrop := int(byteOffset % 16)

	// Increment the 16-byte IV by blockIndex (Big-Endian integer addition)
	newIv := make([]byte, len(iv))
	copy(newIv, iv)

	carry := blockIndex
	for i := 15; i >= 0 && carry > 0; i-- {
		sum := int64(newIv[i]) + carry
		newIv[i] = byte(sum & 0xff)
		carry = sum / 256
	}

	stream := cipher.NewCTR(block, newIv)

	// Advance keystream to align with the offset within the block
	if bytesToDrop > 0 {
		dummy := make([]byte, bytesToDrop)
		stream.XORKeyStream(dummy, dummy)
	}

	return &cipher.StreamReader{S: stream, R: r}, nil
}

// EncryptStream wraps an io.Reader using CTR cipher
func (e *CryptoEngine) EncryptStream(r io.Reader, dek, iv []byte) (io.Reader, error) {
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}

	stream := cipher.NewCTR(block, iv)
	return &cipher.StreamReader{S: stream, R: r}, nil
}

func (e *CryptoEngine) hmacSign(data string) string {
	mac := hmac.New(sha256.New, e.masterSecret)
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

// CreateSignedToken generates a base64url-encoded signed download token
func (e *CryptoEngine) CreateSignedToken(fileID string, tokenType string, ttlSeconds int64, userID string) (string, error) {
	exp := time.Now().Unix() + ttlSeconds
	var sigStr string
	if userID != "" {
		sigStr = fmt.Sprintf("%s:%d:%s:%s", fileID, exp, tokenType, userID)
	} else {
		sigStr = fmt.Sprintf("%s:%d:%s", fileID, exp, tokenType)
	}

	sig := e.hmacSign(sigStr)

	payload := SignedTokenPayload{
		FID: fileID,
		Exp: exp,
		T:   tokenType,
		UID: userID,
		Sig: sig,
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(payloadJSON), nil
}

// VerifySignedToken validates a signed download token and returns its payload
func (e *CryptoEngine) VerifySignedToken(token string) (*SignedTokenPayload, error) {
	payloadJSON, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		payloadJSON, err = base64.URLEncoding.DecodeString(token)
		if err != nil {
			return nil, err
		}
	}

	var payload SignedTokenPayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return nil, err
	}

	if payload.FID == "" || payload.Exp == 0 || payload.T == "" || payload.Sig == "" {
		return nil, errors.New("missing required payload fields")
	}

	var sigStr string
	if payload.UID != "" {
		sigStr = fmt.Sprintf("%s:%d:%s:%s", payload.FID, payload.Exp, payload.T, payload.UID)
	} else {
		sigStr = fmt.Sprintf("%s:%d:%s", payload.FID, payload.Exp, payload.T)
	}

	expectedSig := e.hmacSign(sigStr)

	sigBytes, err := hex.DecodeString(payload.Sig)
	if err != nil {
		return nil, err
	}
	expectedSigBytes, _ := hex.DecodeString(expectedSig)

	if subtle.ConstantTimeCompare(sigBytes, expectedSigBytes) != 1 {
		return nil, errors.New("invalid signature")
	}

	if time.Now().Unix() > payload.Exp {
		return nil, errors.New("token expired")
	}

	return &payload, nil
}

// CreateStreamCookieToken generates a base64url-encoded stream cookie token
func (e *CryptoEngine) CreateStreamCookieToken(subject string, ttlSeconds int64) (string, error) {
	exp := time.Now().Unix() + ttlSeconds
	sigStr := fmt.Sprintf("stream:%s:%d", subject, exp)
	sig := e.hmacSign(sigStr)

	payload := StreamCookiePayload{
		Sub: subject,
		Exp: exp,
		Sig: sig,
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(payloadJSON), nil
}

// VerifyStreamCookieToken validates a stream cookie token
func (e *CryptoEngine) VerifyStreamCookieToken(token string) (*StreamCookiePayload, error) {
	payloadJSON, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		payloadJSON, err = base64.URLEncoding.DecodeString(token)
		if err != nil {
			return nil, err
		}
	}

	var payload StreamCookiePayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return nil, err
	}

	if payload.Sub == "" || payload.Exp == 0 || payload.Sig == "" {
		return nil, errors.New("missing required fields")
	}

	sigStr := fmt.Sprintf("stream:%s:%d", payload.Sub, payload.Exp)
	expectedSig := e.hmacSign(sigStr)

	sigBytes, err := hex.DecodeString(payload.Sig)
	if err != nil {
		return nil, err
	}
	expectedSigBytes, _ := hex.DecodeString(expectedSig)

	if subtle.ConstantTimeCompare(sigBytes, expectedSigBytes) != 1 {
		return nil, errors.New("invalid signature")
	}

	if time.Now().Unix() > payload.Exp {
		return nil, errors.New("token expired")
	}

	return &payload, nil
}
