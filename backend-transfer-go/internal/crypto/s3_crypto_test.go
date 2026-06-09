package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"testing"
)

func TestS3Decryptor_DecryptSecret(t *testing.T) {
	masterSecret := "tele-drive-master-secret-32-byte"
	plainSecret := "rclone-s3-secret-key-1234567890"

	// 1. Encrypt helper mirroring Node.js logic
	encryptedSecret, err := mockEncryptSecret(masterSecret, plainSecret)
	if err != nil {
		t.Fatalf("Failed to encrypt secret: %v", err)
	}

	// 2. Test Decryption
	decryptor, err := NewS3Decryptor(masterSecret)
	if err != nil {
		t.Fatalf("Failed to create decryptor: %v", err)
	}

	decrypted, err := decryptor.DecryptSecret(encryptedSecret)
	if err != nil {
		t.Fatalf("Failed to decrypt: %v", err)
	}

	if decrypted != plainSecret {
		t.Errorf("Expected decrypted secret to be %s, got %s", plainSecret, decrypted)
	}

	// 3. Test legacy plain secret (no colon)
	legacyPlain := "legacy-plain-secret-key"
	decryptedLegacy, err := decryptor.DecryptSecret(legacyPlain)
	if err != nil {
		t.Fatalf("Failed to decrypt legacy secret: %v", err)
	}
	if decryptedLegacy != legacyPlain {
		t.Errorf("Expected legacy secret to be returned as-is (%s), got %s", legacyPlain, decryptedLegacy)
	}
}

// mockEncryptSecret mimics the Node.js S3AuthService.encryptSecret
func mockEncryptSecret(masterSecret, secret string) (string, error) {
	h := sha256.New()
	h.Write([]byte("s3-credential-decryption:"))
	h.Write([]byte(masterSecret))
	masterKey := h.Sum(nil)

	plaintext := []byte(secret)
	// PKCS7 padding
	paddingLen := aes.BlockSize - (len(plaintext) % aes.BlockSize)
	padded := make([]byte, len(plaintext)+paddingLen)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(paddingLen)
	}

	iv := make([]byte, aes.BlockSize)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}

	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return "", err
	}

	mode := cipher.NewCBCEncrypter(block, iv)
	encrypted := make([]byte, len(padded))
	mode.CryptBlocks(encrypted, padded)

	return fmt.Sprintf("%s:%s", hex.EncodeToString(iv), hex.EncodeToString(encrypted)), nil
}
