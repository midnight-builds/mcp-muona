# Security

Muona handles login sessions and purchase history, so please report
vulnerabilities privately: use **Report a vulnerability** on the repository's
Security tab (GitHub private vulnerability reporting). Do not open a public
issue.

There are no versioned releases; fixes land on `main`.

Muona is a personal tool. Secrets (`MCP_AUTH_TOKEN`, S-ostoslista tokens) and
the browser profile holding the S-Etukortti session stay on the machine running
it and are never committed; see `.gitignore`.
