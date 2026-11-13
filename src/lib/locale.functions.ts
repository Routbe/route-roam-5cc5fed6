import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader, getRequest } from "@tanstack/react-start/server";
import { isLocale, type Locale } from "@/lib/i18n";
import { negotiateLocale, readCookieValue } from "@/lib/locale-negotiation";

/**
 * Resolves the visitor's locale on the server so social crawlers — which never
 * run JavaScript — still receive the right OpenGraph card. Order: `/en/` style
 * path prefix, then the `rout_lang` cookie, then `Accept-Language`.
 */
export const getRequestLocale = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    locale: Locale;
  }> => {
    try {
      const pathname = new URL(getRequest().url).pathname;
      const prefix = /^\/(nl|en|fr|de)(?:\/|$)/.exec(pathname)?.[1];
      if (isLocale(prefix)) return { locale: prefix };
    } catch {
      /* no request context (prerender) — fall through */
    }

    // Same negotiation as the root render (cookie, then Accept-Language by q-value)
    // so page metadata and <html lang> never disagree.
    return {
      locale: negotiateLocale({
        cookie: readCookieValue(getRequestHeader("cookie") ?? "", "rout_lang"),
        acceptLanguage: getRequestHeader("accept-language"),
      }),
    };
  },
);
