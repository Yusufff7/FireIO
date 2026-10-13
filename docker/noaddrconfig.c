/*
 * LD_PRELOAD shim: strips AI_ADDRCONFIG from getaddrinfo() hints.
 *
 * Root cause: this container's network interface has an IPv4 address but no
 * IPv6 address (only loopback `lo` has ::1). glibc's AI_ADDRCONFIG check
 * treats that as "IPv6 unconfigured" and refuses to resolve ANY IPv6 target,
 * including ::1 itself. The Vega Virtual Device's QEMU process asks for
 * "::1:<port>" with that flag set (implicitly, via its own getaddrinfo call)
 * and fails with EAI_NONAME ("Name or service not known") before it can open
 * its internal GNSS chardev socket, so the whole VM never finishes booting.
 *
 * We don't have permission to add a real IPv6 address to the container's
 * interface (CAP_NET_ADMIN is granted but the netlink call is still refused,
 * apparently by Docker Desktop's WSL2 networking layer). Patching AVD config
 * doesn't help either — this chardev is unconditional, not gated by hw.gps.
 * So instead: intercept the libc call and clear the one flag responsible.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <stdio.h>

typedef int (*real_getaddrinfo_t)(const char *, const char *,
                                   const struct addrinfo *, struct addrinfo **);

int getaddrinfo(const char *node, const char *service,
                 const struct addrinfo *hints, struct addrinfo **res) {
    static real_getaddrinfo_t real_getaddrinfo = NULL;
    if (!real_getaddrinfo) {
        real_getaddrinfo = (real_getaddrinfo_t)dlsym(RTLD_NEXT, "getaddrinfo");
    }

    struct addrinfo patched;
    if (hints && (hints->ai_flags & AI_ADDRCONFIG)) {
        patched = *hints;
        patched.ai_flags &= ~AI_ADDRCONFIG;
        return real_getaddrinfo(node, service, &patched, res);
    }
    return real_getaddrinfo(node, service, hints, res);
}
