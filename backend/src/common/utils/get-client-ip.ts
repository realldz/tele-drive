/**
 * Extract the real client IP address from a request behind reverse proxies.
 * Priority: X-Forwarded-For (first hop) → X-Real-IP → req.ip → fallback.
 */
export function getClientIp(req: any): string {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (forwardedFor) {
    const first =
      typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]
        : forwardedFor[0]?.split(',')[0];
    if (first) return first.trim();
  }

  const realIp = req.headers?.['x-real-ip'];
  if (realIp) {
    const ip = typeof realIp === 'string' ? realIp : realIp[0];
    if (ip) return ip.trim();
  }

  return req.ip || req.connection?.remoteAddress || '127.0.0.1';
}
