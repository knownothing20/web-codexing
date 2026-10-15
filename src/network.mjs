import { isIP } from 'node:net';

// Direct IPv4 connections only. Never trust proxy or forwarded-IP headers.
export function allowedAddress(address, { tailscale = false } = {}) {
  const ip = address.replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
    || (tailscale && a === 100 && b >= 64 && b <= 127);
}
