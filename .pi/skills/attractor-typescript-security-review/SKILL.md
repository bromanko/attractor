---
name: attractor-typescript-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit TypeScript security", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of TypeScript code including input validation, auth boundaries, and dependency risks.
---

# TypeScript Security Review

**Action required:** Run `/review typescript security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of TypeScript code, examining input validation, auth controls, data exposure, and dependency hygiene.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.ts`, `.tsx`, `.mts`, and `.cts` files
   - If no changes, ask the user what to review

## Review Process

1. **Map attack surface**: API routes, controllers, web forms, CLI inputs, file handlers, webhooks
2. **Trace untrusted data flow** through validation, business logic, and storage/output
3. **Check each security domain** below
4. **Review dependency posture** (`package.json`, lockfiles, build/runtime configs)
5. **Output findings** in the standard format

## Security Checklist

### Input Validation & Parsing
- External input validated at system boundaries
- Uses schema validation (e.g., Zod/io-ts/Valibot/custom guards) before trust
- Length/range/format constraints enforced
- File paths and filenames sanitized (path traversal prevention)
- No implicit trust in query params, headers, or request bodies

### Authentication & Authorization
- Auth checks occur at every sensitive boundary
- Authorization is resource-aware (not just role presence)
- No privilege escalation via alternate endpoints/flags
- Session/token validation robust (expiry, signature, audience/issuer as applicable)
- Sensitive operations require explicit permission checks

### Injection & Output Safety
- SQL/NoSQL queries parameterized (no string-concatenated queries)
- Command execution avoids shell interpolation of untrusted input
- Template rendering/UI output prevents XSS (escaping/sanitization)
- URL redirects validated (no open redirects)
- SSRF risks mitigated for user-supplied URLs

### Secrets & Sensitive Data
- No hardcoded secrets, API keys, or credentials
- Secrets loaded via environment/secret manager
- Sensitive values excluded from logs and error payloads
- Stack traces/internal details not exposed to clients in production
- PII handling follows least-exposure principles

### Dependency & Supply Chain
- Dependencies come from trusted registries/sources
- Vulnerability scanning expected (`npm audit`, `pnpm audit`, SCA tooling)
- Lockfile present and committed
- Avoids unnecessary high-risk dependencies
- Build scripts and postinstall hooks reviewed for trust boundaries

### Transport & External Integrations
- External calls use HTTPS with certificate validation
- Timeouts and retry limits configured
- Webhook signature verification implemented where relevant
- CORS configured restrictively (not wildcard with credentials)
- Rate limiting and abuse controls considered for public endpoints

### Unsafe Patterns & Hardening
- No use of `eval`, `new Function`, or dynamic code execution on untrusted input
- Deserialization/parsing of complex objects guarded
- Dangerous defaults overridden in framework/security middleware
- Debug/dev-only paths not exposed in production deployments
- Security headers configured where applicable (CSP, HSTS, etc.)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.ts:LINE`
**Category:** security

**Issue:** Description of the vulnerability and potential impact.

**Suggestion:** How to remediate, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Exploitable vulnerabilities, auth bypass, sensitive data exposure
- MEDIUM: Missing controls, unsafe defaults, weak validation patterns
- LOW: Hardening improvements and best-practice deviations

## Summary

After all findings, provide:
- Total count by severity
- Critical items requiring immediate attention
- Attack surface summary
- Dependency risk snapshot
- Overall security posture (1-2 sentences)
