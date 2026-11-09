import { useEffect, useState } from 'react';

export type Route = { path: string; segments: string[]; query: URLSearchParams };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/runs';
  const [p, q = ''] = raw.split('?');
  const path = p.startsWith('/') ? p : `/${p}`;
  return { path, segments: path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(href: string) {
  window.location.hash = href.replace(/^#/, '');
}

export const href = {
  runs: () => '#/runs',
  run: (id: string) => `#/runs/${encodeURIComponent(id)}`,
  trial: (id: string, row: string) => `#/runs/${encodeURIComponent(id)}?row=${encodeURIComponent(row)}`,
  trialPage: (id: string, row: string) => `#/runs/${encodeURIComponent(id)}/trial?row=${encodeURIComponent(row)}`,
  case: (id: string) => `#/cases?q=${encodeURIComponent(id)}`,
  personas: () => '#/personas',
  person: (id: string) => `#/personas/${encodeURIComponent(id)}`,
  /** A trial page (results dir or run store); `view` picks the tab (chat is the default for conversations). */
  chat: (id: string, row: string, store = false) => `#/${store ? 'store' : 'runs'}/${encodeURIComponent(id)}/trial?row=${encodeURIComponent(row)}`,
};
