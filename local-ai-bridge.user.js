// ==UserScript==
// @name         Gemini Character RP Local AI Bridge
// @namespace    https://github.com/local-ai-bridge
// @version      1.0.0
// @description  Lets the Netlify-hosted Gemini Character RP app call Ollama and LM Studio on your PC through Tampermonkey.
// @author       Gemini Character RP
// @match        https://geminicharacterroleplay.netlify.app/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      10.*
// @connect      172.*
// @connect      192.168.*
// @connect      *.local
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const BRIDGE_VERSION = '1.0.0';
    const interceptedPaths = [
        '/api/chat',
        '/api/generate',
        '/api/tags',
        '/v1/chat/completions',
        '/v1/models',
        '/models',
        '/chat/completions',
    ];

    const page = unsafeWindow || window;
    const nativeFetch = page.fetch.bind(page);

    function isPrivateHost(hostname) {
        const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return true;
        if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
        if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
        const lanMatch = host.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
        if (lanMatch) {
            const secondOctet = Number(lanMatch[1]);
            return secondOctet >= 16 && secondOctet <= 31;
        }
        return false;
    }

    function shouldBridge(url) {
        if (url.protocol !== 'http:') return false;
        if (!isPrivateHost(url.hostname)) return false;
        return interceptedPaths.some(path => url.pathname === path || url.pathname.endsWith(path));
    }

    function copyHeaders(headersLike, target) {
        if (!headersLike) return;
        if (headersLike instanceof page.Headers || headersLike instanceof Headers) {
            headersLike.forEach((value, key) => {
                target[key] = value;
            });
            return;
        }
        if (Array.isArray(headersLike)) {
            headersLike.forEach(([key, value]) => {
                target[key] = value;
            });
            return;
        }
        Object.entries(headersLike).forEach(([key, value]) => {
            target[key] = value;
        });
    }

    function parseResponseHeaders(rawHeaders) {
        const headers = new page.Headers();
        String(rawHeaders || '').trim().split(/[\r\n]+/).forEach(line => {
            const separator = line.indexOf(':');
            if (separator > 0) {
                headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
            }
        });
        return headers;
    }

    function requestThroughTampermonkey(input, init, url) {
        const requestHeaders = {};
        const request = typeof input === 'object' && input instanceof page.Request ? input : null;
        copyHeaders(request?.headers, requestHeaders);
        copyHeaders(init?.headers, requestHeaders);

        const method = init?.method || request?.method || 'GET';
        const body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: url.href,
                headers: requestHeaders,
                data: body,
                responseType: 'text',
                timeout: 0,
                onload: response => {
                    resolve(new page.Response(response.responseText || '', {
                        status: response.status || 200,
                        statusText: response.statusText || 'OK',
                        headers: parseResponseHeaders(response.responseHeaders),
                    }));
                },
                onerror: error => reject(new page.TypeError(`Local AI Bridge request failed: ${error.error || 'network error'}`)),
                ontimeout: () => reject(new page.TypeError('Local AI Bridge request timed out')),
                onabort: () => reject(new page.TypeError('Local AI Bridge request was aborted')),
            });
        });
    }

    page.fetch = function bridgedFetch(input, init) {
        const rawUrl = typeof input === 'string' || input instanceof page.URL ? String(input) : input?.url;
        if (!rawUrl) return nativeFetch(input, init);

        let url;
        try {
            url = new page.URL(rawUrl, page.location.href);
        } catch (error) {
            return nativeFetch(input, init);
        }

        if (!shouldBridge(url)) {
            return nativeFetch(input, init);
        }

        return requestThroughTampermonkey(input, init, url);
    };

    page.__GCRP_LOCAL_AI_BRIDGE__ = {
        active: true,
        version: BRIDGE_VERSION,
        startedAt: new Date().toISOString(),
    };

    page.dispatchEvent(new page.CustomEvent('gcrp-local-ai-bridge-ready', {
        detail: page.__GCRP_LOCAL_AI_BRIDGE__,
    }));

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Gemini Character RP Local AI Bridge: status', () => {
            page.alert(`Local AI Bridge is active. Version: ${BRIDGE_VERSION}`);
        });
    }

    console.info(`[Gemini Character RP] Local AI Bridge active v${BRIDGE_VERSION}`);
})();
