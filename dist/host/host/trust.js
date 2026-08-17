function header(headers, name) {
    if (headers instanceof Headers)
        return headers.get(name) ?? undefined;
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
}
function parseAuthority(authority) {
    try {
        const parsed = new URL(`http://${authority}`);
        if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/')
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** True only for localhost, IPv6 loopback, and canonical IPv4 addresses in 127/8. */
export function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
 * DNS-rebinding and cross-site fence for privileged local IDE routes.
 * This deliberately does not authorize LAN authorities: v1 has no authentication.
 */
export function isTrustedLocalRequest(request) {
    const authority = header(request.headers, 'host');
    if (authority === undefined)
        return false;
    const host = parseAuthority(authority);
    if (host === undefined || !isLoopbackHostname(host.hostname))
        return false;
    if (header(request.headers, 'sec-fetch-site') === 'cross-site')
        return false;
    const origin = header(request.headers, 'origin');
    if (origin === undefined)
        return true;
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host.host;
    }
    catch {
        return false;
    }
}
