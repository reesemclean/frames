/// <reference types="vite/client" />
import type { ReactNode } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { QueryClientProvider } from '@tanstack/react-query'
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import appCss from '~/styles/app.css?url'

// Self-heal: if the app never started or its stylesheet never applied (a
// stale page after a deploy, a network blip at boot), reload until both did.
// base.css makes #stage absolute; unstyled, it's static. One reload per 15 s
// at most, which the kiosk tolerates.
// A dashboard path without #stage is an error or 404 page (a bad dashboard
// file, an SSR crash, a tree that died): the kiosk only retries network
// errors, so retry it every 60 s until the dashboard renders again. Never on
// / or /admin. The path is re-read each time (desktop browsers navigate).
const SELF_HEAL = `(function () {
  function dashPath() { var p = location.pathname; return /^[/][a-z0-9-]+[/]?$/.test(p) && !/^[/]admin[/]?$/.test(p); }
  setTimeout(function () {
    var stage = document.getElementById('stage');
    if (!stage) return;
    var styled = getComputedStyle(stage).position === 'absolute';
    if (!window.FRAMES || !window.FRAMES.started || !styled) location.reload();
  }, 15000);
  var missing = 0;
  setInterval(function () {
    missing = dashPath() && !document.getElementById('stage') ? missing + 1 : 0;
    if (missing >= 2) location.reload();
  }, 30000);
})();`

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=1280, initial-scale=1, user-scalable=no' },
      { title: 'Frames' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  return (
    <Document>
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </Document>
  )
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: SELF_HEAL }} />
        <Scripts />
      </body>
    </html>
  )
}
