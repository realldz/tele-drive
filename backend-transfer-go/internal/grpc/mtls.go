package grpc

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"google.golang.org/grpc/credentials"
)

// loadCertPool reads a PEM CA bundle into an x509 pool used to verify the peer.
func loadCertPool(caFile string) (*x509.CertPool, error) {
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA cert %q: %w", caFile, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("no valid certificate found in CA bundle %q", caFile)
	}
	return pool, nil
}

// ServerTLSCreds builds mTLS transport credentials for the gRPC server: it
// presents its own leaf cert AND requires every client to present a cert signed
// by the internal CA (tls.RequireAndVerifyClientCert). Any peer without a valid
// cert is rejected at the TLS handshake, before any RPC handler runs.
func ServerTLSCreds(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
	leaf, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load server keypair: %w", err)
	}
	caPool, err := loadCertPool(caFile)
	if err != nil {
		return nil, err
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{leaf},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    caPool,
		MinVersion:   tls.VersionTLS12,
	}), nil
}

// ClientTLSCreds builds mTLS transport credentials for the gRPC client: it
// presents its own leaf cert and verifies the server's cert against the
// internal CA. serverName must match a SAN on the server's cert (the dns:///
// authority, e.g. "backend-core") so hostname verification passes.
func ClientTLSCreds(certFile, keyFile, caFile, serverName string) (credentials.TransportCredentials, error) {
	leaf, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client keypair: %w", err)
	}
	caPool, err := loadCertPool(caFile)
	if err != nil {
		return nil, err
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{leaf},
		RootCAs:      caPool,
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS12,
	}), nil
}
