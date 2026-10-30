# Glossary

Domain terms for S-group authentication. Code, logs and docs use these names.

**S-tunnus SSO session** — the identity-provider session at tunnistus.s-ryhma.fi,
held as cookies in the persistent S-Etukortti browser profile. Long-lived
(hundreds of hours observed). Shared by every S-group service we log in to.
_Avoid_: "the session" unqualified.

**App session** — a single service's own logged-in state on top of the SSO
session. For S-Etukortti: s-etukortti.fi cookies plus a CSRF token, dying in
under an hour. For S-ostoslista: the anonymous + access/refresh token chain.
_Avoid_: "login" for this; a login is what creates one.

**Silent login** — a login that completes without a human because the SSO
session is still alive (submit the saved email, land back on the service).
Takes seconds. The only kind of login the code ever starts on its own.

**Human login** — a login that needs an email one-time code, a captcha or
strong authentication (bank ID, done through the remote login screen). Never
automated: the code only drives the steps a human feeds it.

**Relogin** — the automatic attempt, after an app session is found expired, to
restore it with a silent login. Shared: every caller that hit the expiry waits
for the same attempt.

**Human step** — a captcha, one-time-code or strong-authentication screen. An
automatic flow that reaches one stops there.

**Relogin block** — persisted flag set when an automatic flow reaches a
recognised human step. While set, no automatic flow starts, so each SSO expiry
costs at most one automatically triggered one-time-code email (a relogin hands
that one to the human; an S-ostoslista flow cannot, so then the human's own
login mails a second). While set, a human login is forced through the IdP.
Cleared only by a completed login that went through the IdP.

**Cooldown** — the 20-minute wait after a *failed* relogin (network error,
site hiccup) before another may start; the automatic S-ostoslista login waits
the same after a failed flow. Any login that completes afterwards (a human
finishing a handed-over relogin, a manual login) lifts it. A successful relogin
starts no cooldown.

**Minimum relogin interval** — the 10 minutes after a *successful* relogin
completed in which another relogin is declined (still_unauthorized) while the
app session still looks alive (a CSRF token is issued but the API answers
401/403): a relogin would not fix that, so no IdP flow runs. A CSRF refresh
that answers logged out (a real logout) allows the relogin inside the window.

**IdP lease** — the in-process right to drive the shared SSO cookie jar.
Exclusive for human logins and silent logins; shared for background page
navigations, which never run while a human login holds it.

**Profile lock** — the cross-process lock on a browser profile directory, so
the server and `bun run login` never open the same profile at once.
