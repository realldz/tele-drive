package crypto

import (
	"bytes"
	"io"
	"testing"
)

func TestCryptoEngine_KeyEncryption(t *testing.T) {
	masterSecret := "tele-drive-master-secret-32-byte"
	engine, err := NewCryptoEngine(masterSecret)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}

	dek, err := engine.GenerateFileKey()
	if err != nil {
		t.Fatalf("Failed to generate DEK: %v", err)
	}

	encrypted, err := engine.EncryptKey(dek)
	if err != nil {
		t.Fatalf("Failed to encrypt DEK: %v", err)
	}

	decrypted, err := engine.DecryptKey(encrypted)
	if err != nil {
		t.Fatalf("Failed to decrypt DEK: %v", err)
	}

	if !bytes.Equal(dek, decrypted) {
		t.Error("Decrypted key does not match original DEK")
	}
}

func TestCryptoEngine_StreamEncryptionAndOffsetDecryption(t *testing.T) {
	masterSecret := "tele-drive-master-secret-32-byte"
	engine, err := NewCryptoEngine(masterSecret)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}

	dek, _ := engine.GenerateFileKey()
	iv, _ := engine.GenerateIv()

	plaintext := []byte("0123456789abcdefghijklmnopqrstuvwxyz") // 36 bytes

	// 1. Encrypt stream
	encStream, err := engine.EncryptStream(bytes.NewReader(plaintext), dek, iv)
	if err != nil {
		t.Fatalf("Failed to encrypt: %v", err)
	}

	ciphertext, err := io.ReadAll(encStream)
	if err != nil {
		t.Fatalf("Failed to read ciphertext: %v", err)
	}

	// 2. Decrypt full stream (offset 0)
	decStream, err := engine.DecryptStreamWithOffset(bytes.NewReader(ciphertext), dek, iv, 0)
	if err != nil {
		t.Fatalf("Failed to decrypt: %v", err)
	}
	decrypted, err := io.ReadAll(decStream)
	if err != nil {
		t.Fatalf("Failed to read decrypted text: %v", err)
	}
	if !bytes.Equal(plaintext, decrypted) {
		t.Error("Full decrypted text does not match plaintext")
	}

	// 3. Decrypt with offset (Range request)
	// Let's seek to offset 10 ("abcdefghijklmnopqrstuvwxyz")
	offset := int64(10)
	decOffsetStream, err := engine.DecryptStreamWithOffset(bytes.NewReader(ciphertext[offset:]), dek, iv, offset)
	if err != nil {
		t.Fatalf("Failed to decrypt with offset: %v", err)
	}
	decryptedOffset, err := io.ReadAll(decOffsetStream)
	if err != nil {
		t.Fatalf("Failed to read decrypted text from offset: %v", err)
	}

	expectedOffset := plaintext[offset:]
	if !bytes.Equal(expectedOffset, decryptedOffset) {
		t.Errorf("Expected decrypted offset block to be %q, got %q", string(expectedOffset), string(decryptedOffset))
	}
}

func TestCryptoEngine_SignedTokens(t *testing.T) {
	masterSecret := "tele-drive-master-secret-32-byte"
	engine, err := NewCryptoEngine(masterSecret)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}

	fileID := "test-file-id"
	userID := "test-user-id"

	// 1. Test user download token
	token, err := engine.CreateSignedToken(fileID, "u", 3600, userID)
	if err != nil {
		t.Fatalf("Failed to create signed token: %v", err)
	}

	payload, err := engine.VerifySignedToken(token)
	if err != nil {
		t.Fatalf("Failed to verify signed token: %v", err)
	}

	if payload.FID != fileID || payload.T != "u" || payload.UID != userID {
		t.Errorf("Token payload mismatch: %+v", payload)
	}

	// 2. Test shared folder token (without userID)
	tokenSF, err := engine.CreateSignedToken(fileID, "sf", 3600, "")
	if err != nil {
		t.Fatalf("Failed to create signed token SF: %v", err)
	}

	payloadSF, err := engine.VerifySignedToken(tokenSF)
	if err != nil {
		t.Fatalf("Failed to verify signed token SF: %v", err)
	}

	if payloadSF.FID != fileID || payloadSF.T != "sf" || payloadSF.UID != "" {
		t.Errorf("Token payload SF mismatch: %+v", payloadSF)
	}
}

func TestCryptoEngine_StreamCookies(t *testing.T) {
	masterSecret := "tele-drive-master-secret-32-byte"
	engine, err := NewCryptoEngine(masterSecret)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}

	subject := "user-id-or-ip"
	token, err := engine.CreateStreamCookieToken(subject, 3600)
	if err != nil {
		t.Fatalf("Failed to create stream cookie: %v", err)
	}

	payload, err := engine.VerifyStreamCookieToken(token)
	if err != nil {
		t.Fatalf("Failed to verify stream cookie: %v", err)
	}

	if payload.Sub != subject {
		t.Errorf("Expected subject %s, got %s", subject, payload.Sub)
	}
}
