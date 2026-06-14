package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

type S3Decryptor struct {
	masterKey []byte
}

func NewS3Decryptor(masterSecret string) (*S3Decryptor, error) {
	if masterSecret == "" {
		return nil, errors.New("MASTER_SECRET environment variable is not set")
	}
	// Derive a 32-byte key from MASTER_SECRET using SHA256 with domain separation
	h := sha256.New()
	h.Write([]byte("s3-credential-decryption:"))
	h.Write([]byte(masterSecret))
	key := h.Sum(nil)
	return &S3Decryptor{masterKey: key}, nil
}

// DecryptSecret decrypts a stored secretAccessKey
func (d *S3Decryptor) DecryptSecret(encryptedSecret string) (string, error) {
	// Handle legacy plain secrets (not encrypted)
	if !strings.Contains(encryptedSecret, ":") {
		return encryptedSecret, nil
	}

	parts := strings.Split(encryptedSecret, ":")
	if len(parts) != 2 {
		return "", errors.New("invalid encrypted secret format")
	}

	ivHex := parts[0]
	encryptedHex := parts[1]

	iv, err := hex.DecodeString(ivHex)
	if err != nil {
		return "", err
	}

	encrypted, err := hex.DecodeString(encryptedHex)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(d.masterKey)
	if err != nil {
		return "", err
	}

	if len(iv) != aes.BlockSize {
		return "", errors.New("invalid IV size")
	}

	if len(encrypted)%aes.BlockSize != 0 {
		return "", errors.New("encrypted data block size mismatch")
	}

	mode := cipher.NewCBCDecrypter(block, iv)
	decrypted := make([]byte, len(encrypted))
	mode.CryptBlocks(decrypted, encrypted)

	// Remove PKCS7 padding
	decrypted, err = pkcs7Unpad(decrypted)
	if err != nil {
		return "", err
	}

	return string(decrypted), nil
}

// pkcs7Unpad validates and removes PKCS7 padding
func pkcs7Unpad(data []byte) ([]byte, error) {
	length := len(data)
	if length == 0 {
		return nil, errors.New("empty data")
	}

	padding := int(data[length-1])
	if padding < 1 || padding > aes.BlockSize {
		return nil, errors.New("invalid padding size")
	}

	for i := 0; i < padding; i++ {
		if int(data[length-1-i]) != padding {
			return nil, errors.New("invalid padding bytes")
		}
	}

	return data[:length-padding], nil
}
