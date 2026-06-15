import * as fs from 'fs';
import {
  ServerCredentials,
  ChannelCredentials,
  credentials,
} from '@grpc/grpc-js';

/**
 * Resolve the gRPC mTLS material from GRPC_TLS_* env paths. Returns null when
 * none are set so callers fall back to plaintext (local dev, non-Docker). Any
 * path set requires all three so a half-configured TLS never silently
 * downgrades to plaintext.
 */
function loadTlsFiles(): {
  ca: Buffer;
  key: Buffer;
  cert: Buffer;
} | null {
  const caPath = process.env.GRPC_TLS_CA;
  const keyPath = process.env.GRPC_TLS_KEY;
  const certPath = process.env.GRPC_TLS_CERT;

  if (!caPath && !keyPath && !certPath) {
    return null;
  }
  if (!caPath || !keyPath || !certPath) {
    throw new Error(
      'Partial gRPC TLS config: GRPC_TLS_CA, GRPC_TLS_KEY, and GRPC_TLS_CERT must all be set together.',
    );
  }
  return {
    ca: fs.readFileSync(caPath),
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

/**
 * Server-side mTLS credentials for the NestJS CoreService gRPC server. Presents
 * this service's leaf cert AND requires every client to present a cert signed
 * by the internal CA (checkClientCertificate=true). Returns null → plaintext.
 */
export function buildServerCredentials(): ServerCredentials | null {
  const tls = loadTlsFiles();
  if (!tls) return null;
  return ServerCredentials.createSsl(
    tls.ca,
    [{ private_key: tls.key, cert_chain: tls.cert }],
    true,
  );
}

/**
 * Client-side mTLS credentials for the NestJS → Go TransferService channel.
 * Presents this service's leaf cert and verifies the Go server against the
 * internal CA. Returns null → plaintext.
 */
export function buildClientCredentials(): ChannelCredentials | null {
  const tls = loadTlsFiles();
  if (!tls) return null;
  return credentials.createSsl(tls.ca, tls.key, tls.cert);
}
