# Browser appearance

The research screen and password-login screen both offer the same **Тема**
selector: **Как в системе**, **Светлая**, **Тёмная**. By default the
browser's operating-system preference is followed. An explicit choice is
stored on the current browser/origin under `sat_theme_preference` and
applied before paint on either page. OS changes are respected in system
mode; other tabs synchronize the choice. No server requests, account
setting, cookie change, database write, or reload are needed to switch.

Both pages share the same small inline bootstrap (checked for equality in
tests). The login page remains self-contained so public CSS/JS does not
need an auth middleware exception. Theme palettes cover the progress
indicator, stage states, job selection, errors, inputs, buttons, tables
and status badges. Native controls use the correct color-scheme. Mobile
layout, keyboard focus and reduced-motion preferences are supported.
Existing study actions, polling, authentication, XLSX format and
deployment settings are untouched.

If localStorage is unavailable, the choice still works in the current
page but may not survive navigation. Each browser/device has its own
preference. Offline tests exercise bootstrap, persistence, media events,
cross-tab synchronization and color contrast. A live browser visual
check after deployment is still recommended.
