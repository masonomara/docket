# Email-First Authentication Flow

## Ultimate Goal

Consolidate login and signup into a single auth flow.

## Current Status

Two separate routes, both support Google OAuth and email invitation flows:

- `/login` - email, password, continue button, link to `/signup`
- `/signup` - name, email, password, continue button, link to `/login`

**Email Invitations:**

Org admins invite users to join. Preserve this functionality.

**Key Files:**

- `apps/api/src/index.ts`
- `apps/api/src/handlers/auth.ts`
- `apps/web/app/routes/auth.tsx`
- `apps/web/app/routes/login.tsx`
- `apps/web/app/routes/signup.tsx`
- `apps/web/app/styles/auth.module.css`

## Proposed Flow Visual

```text
┌─────────────────────────────────────┐
│           /auth                     │
│                                     │
│  [Continue with Google]             │
│                                     │
│  ─────────── or ───────────         │
│                                     │
│  Email: [________________]          │
│                                     │
│  [Continue]                         │
└─────────────────────────────────────┘
                 │
                 ▼
        ┌───────────────┐
        │ POST /api/    │
        │ check-email   │
        └───────┬───────┘
                │
       ┌────────┴────────┐
       │                 │
       ▼                 ▼
  exists: true      exists: false
       │                 │
       ▼                 ▼
┌─────────────┐   ┌─────────────────┐
│  STEP 2a    │   │    STEP 2b      │
│  Password   │   │  Name+Password  │
│  [______]   │   │  [______]       │
│             │   │  [______]       │
│  [Log in]   │   │  [Sign up]      │
└─────────────┘   └─────────────────┘
       │                 │
       ▼                 ▼
  signIn.email     signUp.email
       │                 │
       ▼                 ▼
   Dashboard      Verify Email
```

## Invitation Handling

When `?invitation=xyz` is present:

1. Direct to login flow with email from invitation (may need to modify invitation email link)
   - User enters password and logs in
2. After auth, redirect to `/accept-invite?invitation=xyz`

No changes to invitation acceptance logic—just routing.

## Frontend States

**Email Entry (Initial):**

```text
┌─────────────────────────────────────┐
│           /auth                     │
│                                     │
│  [Continue with Google]             │
│                                     │
│  ─────────── or ───────────         │
│                                     │
│  Email: [________________]          │
│                                     │
│  [Continue]                         │
└─────────────────────────────────────┘
```

Google OAuth, email input, continue button.

**Email Login (Step 2a):**

```text
┌─────────────┐
│  STEP 2a    │
│  Password   │
│  [______]   │
│             │
│  [Log in]   │
└─────────────┘
```

Email displayed (read-only with "Change" link), password input, forgot password link, log in button. Calls `signIn.email()` on submit.

If invitation, no "Change" link.

**Email Signup (Step 2b):**

```text
┌─────────────────┐
│    STEP 2b      │
│  Name+Password  │
│  [______]       │
│  [______]       │
│  [Sign up]      │
└─────────────────┘
```

Email displayed (read-only with "Change" link), name input, password input, forgot password link, create account button. Calls `signUp.email()` on submit.

## API Design

**`POST /api/check-email`:**

Checks if an email is registered.

Fields:

- `exists`: User record exists in `user` table
- `hasPassword`: User has a credential-based account (not just OAuth)

Flow:

- `apps/api/src/handlers/auth.ts`
  - Query D1 directly—user table has unique index on email
  - Check if user has a password-based account
- `apps/api/src/index.ts`
  - Route registration

## Storage Interaction

No new tables or migrations. Both queries hit indexed columns:

- Check email exists: `user` table, `user_email_unique` index
- Check has password: `account` table, `account_userId_idx` index

## Error Handling

- Email already registered (on signup): Better Auth returns error, show "Account exists, try logging in"
- Wrong password: Better Auth returns 401, show "Incorrect password"
- Email not verified: Better Auth returns 403, show verification prompt
- Network error: Show retry option

## Development Plan

1. Create `/auth` route with unified flow
2. Add `handleCheckEmail` API endpoint
3. Update all internal links to use `/auth`
4. After verification, delete old routes

**Manual Testing Checkpoints:**

- [x] New user signup flow completes
- [x] Existing user login flow completes
- [x] Google OAuth works
- [x] "Change" email link works in step 2
- [x] Forgot password link works
- [x] Invitation flow pre-fills email
- [x] Error messages display correctly

## Testing

Test key events: email check, signup start, login start, auth complete.

**Unit Tests:**

- Setup: user with password
- Setup: user who signed up with Google only
  - Should match user@example.com in DB

**Integration Tests:**

- New user: email → signup form → verify email
- Existing user: email → login form → dashboard
- OAuth-only user: email → OAuth prompt
- Invitation flow: email locked, redirects to accept
