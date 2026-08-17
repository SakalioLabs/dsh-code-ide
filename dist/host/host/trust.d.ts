import type { IncomingHttpHeaders } from 'node:http';
interface TrustRequest {
    headers: IncomingHttpHeaders | Headers;
}
/** True only for localhost, IPv6 loopback, and canonical IPv4 addresses in 127/8. */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * DNS-rebinding and cross-site fence for privileged local IDE routes.
 * This deliberately does not authorize LAN authorities: v1 has no authentication.
 */
export declare function isTrustedLocalRequest(request: TrustRequest): boolean;
export {};
