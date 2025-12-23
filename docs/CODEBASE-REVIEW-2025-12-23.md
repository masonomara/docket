# Docket Codebase Review - Production Readiness Audit

## Review Panel

| Agent       | Perspective                        | Focus Areas                                                           |
| ----------- | ---------------------------------- | --------------------------------------------------------------------- |
| **Matthew** | Christian Senior Software Engineer | Security, technical correctness, type safety, data integrity          |
| **Manoj**   | Taoist Project Manager             | Simplicity, flow, scope discipline, over-engineering                  |
| **Jew**     | Lawyerly Supervisor                | GDPR compliance, legal industry requirements, liability, audit trails |
| **Chego**   | Nicaraguan Coworker                | Developer experience, debugging, configuration, operations            |

### ARCH-01: 2300-Line index.ts File

**Identified by:** Manoj, Chego
**Why it blocks:** Adding web-facing endpoints to this file is unmaintainable.
**Action:**

- [ ] Extract TenantDO to `apps/api/src/do/tenant.ts`
- [ ] Extract OAuth handlers to separate file
- [ ] Leave Worker routing in index.ts (<200 lines)

### High Priority (Add to Appropriate Phase)

### ARCH-02: Premature Monorepo Split

**Identified by:** Manoj
**Decision needed:** Keep structure for Phase 9 web app, or flatten?
**Action:**

- [ ] Document why structure exists, or flatten before Phase 9

---
