# Phase 9 Tutorial: Building the Website MVP

This tutorial walks you through building Docket's web application—the administrative interface where law firms manage their organizations, invite team members, connect to Clio, and upload firm-specific documents.

**What you'll build:**

- Authentication UI (signup/login with email, Google, Apple)
- Organization creation and management
- Member invitation system
- Clio OAuth connection flow
- Org Context document upload interface

---

## Section 1: Understanding What You're Building

### 1.1 The Big Picture

Docket is a chatbot for law firms. Users primarily interact through Microsoft Teams—they message the bot, and it helps them manage cases in Clio. But before that can happen, someone needs to:

1. Create a Docket account
2. Create an organization (their law firm)
3. Invite team members
4. Connect their Clio account
5. Upload firm-specific documents (Org Context)

That's what this web app does. Think of it as the "admin panel" that makes the chatbot functional.

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Journey                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. Website MVP (Phase 9)          2. Teams Bot (Phase 10)     │
│   ┌──────────────────────┐          ┌──────────────────────┐    │
│   │ • Sign up            │          │ • Chat with Docket   │    │
│   │ • Create org         │   ───►   │ • Query Clio data    │    │
│   │ • Invite members     │          │ • Get AI assistance  │    │
│   │ • Connect Clio       │          │                      │    │
│   │ • Upload docs        │          │                      │    │
│   └──────────────────────┘          └──────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Why React Router 7 on Cloudflare Pages?

The project uses **React Router 7** (the framework mode, formerly Remix) running on **Cloudflare Pages**. This combination gives us:

1. **Server-side rendering (SSR)** — Pages load with content already rendered, improving perceived performance and SEO
2. **Edge deployment** — Pages Functions run on Cloudflare's edge network, close to users
3. **Unified deployment** — One platform for both API (Workers) and web app (Pages)
4. **Type safety** — React Router 7's typegen gives us end-to-end type safety for loaders/actions

The web app (`apps/web`) communicates with the API worker (`apps/api`) for all data operations. The API handles:

- Authentication (Better Auth on D1)
- Organization data (D1)
- Document uploads (R2 + Vectorize)
- Clio OAuth (Durable Object storage)

### 1.3 Data Flow Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Request Flow                                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   Browser                  Cloudflare Pages              API Worker   │
│   ┌──────┐                ┌─────────────────┐           ┌──────────┐ │
│   │      │  1. Request    │                 │ 3. Fetch  │          │ │
│   │ User │ ────────────►  │  React Router   │ ───────►  │  Better  │ │
│   │      │                │  (SSR + Client) │           │   Auth   │ │
│   │      │  4. Rendered   │                 │ Response  │          │ │
│   │      │ ◄────────────  │                 │ ◄───────  │   D1     │ │
│   └──────┘                └─────────────────┘           │   R2     │ │
│                                                         │   DO     │ │
│                           2. Loader runs                └──────────┘ │
│                              on edge                                  │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Key insight:** The web app doesn't directly access D1, R2, or Durable Objects. It talks to the API worker, which handles all data operations. This separation means:

- Auth logic lives in one place (API)
- The web app can be swapped for a mobile app later
- Security boundaries are clear

---

## Section 2: Architecture Deep-Dive

### 2.1 The Two Apps

```
apps/
├── api/                    # Cloudflare Worker
│   ├── src/
│   │   ├── index.ts        # Request routing
│   │   ├── lib/auth.ts     # Better Auth config
│   │   ├── do/tenant.ts    # Durable Object
│   │   └── handlers/       # Route handlers
│   └── wrangler.jsonc      # Worker config
│
└── web/                    # Cloudflare Pages (React Router 7)
    ├── app/
    │   ├── root.tsx        # App shell
    │   ├── routes/         # File-based routing
    │   └── lib/
    │       └── auth-client.ts  # Better Auth client
    └── wrangler.jsonc      # Pages config
```

### 2.2 Authentication Architecture

Better Auth provides both server and client components:

**Server (API Worker):**

```typescript
// apps/api/src/lib/auth.ts
export function getAuth(env: AuthEnv) {
  return betterAuth({
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite" }),
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
      apple: {
        clientId: env.APPLE_CLIENT_ID,
        clientSecret: env.APPLE_CLIENT_SECRET,
      },
    },
  });
}
```

**Client (Web App):**

```typescript
// apps/web/app/lib/auth-client.ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "https://api.docket.com", // Your API worker URL
});

export const { useSession, signIn, signUp, signOut } = authClient;
```

The client talks to `/api/auth/*` endpoints on your API worker. Better Auth handles:

- Session cookies (httpOnly, secure)
- OAuth flows (redirect-based)
- Password hashing (PBKDF2)

### 2.3 Organization Model

Organizations are central to Docket's multi-tenancy. Here's how they relate:

```
┌────────────────────────────────────────────────────────────────────┐
│                     Data Relationships                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   user (D1)                 org (D1)              TenantDO (DO)    │
│   ┌─────────┐              ┌─────────────┐       ┌──────────────┐  │
│   │ id      │              │ id          │       │ org_id       │  │
│   │ email   │──────┐       │ name        │◄──────│ SQLite:      │  │
│   │ name    │      │       │ jurisdictions│      │  conversations│  │
│   └─────────┘      │       │ practice_types│     │  messages    │  │
│                    │       │ firm_size   │       │  settings    │  │
│                    ▼       └─────────────┘       │ KV Storage:  │  │
│              org_members        ▲                │  clio_tokens │  │
│              ┌───────────┐      │                └──────────────┘  │
│              │ user_id   │──────┘                                  │
│              │ org_id    │                                         │
│              │ role      │  (admin | member | owner)               │
│              │ is_owner  │                                         │
│              └───────────┘                                         │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Key rules:**

- One user can belong to one org (simplified model for legal compliance)
- Owner is an Admin with `is_owner: true`
- Owner cannot be removed; must transfer ownership first
- Each org has exactly one Durable Object (DO ID = org ID)

### 2.4 File Upload Architecture

When an Admin uploads a document (PDF, DOCX, etc.), here's what happens:

```
┌────────────────────────────────────────────────────────────────────┐
│                    Document Upload Flow                             │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Upload Request                                                  │
│     ┌──────────┐        ┌──────────────┐                           │
│     │ Browser  │───────►│ API Worker   │                           │
│     │ (FormData)│        │ /api/org-    │                           │
│     └──────────┘        │  context     │                           │
│                         └──────┬───────┘                           │
│                                │                                    │
│  2. Validate & Store          │                                    │
│                                ▼                                    │
│     ┌──────────────────────────────────────────────────┐           │
│     │ • Check MIME type + extension                     │           │
│     │ • Verify magic bytes (file header)               │           │
│     │ • Check size (25MB limit)                        │           │
│     │ • Sanitize filename (no path traversal)          │           │
│     │ • Store raw file in R2: /orgs/{org_id}/docs/     │           │
│     └──────────────────────────────────────────────────┘           │
│                                │                                    │
│  3. Extract & Chunk           │                                    │
│                                ▼                                    │
│     ┌──────────────────────────────────────────────────┐           │
│     │ • Parse to text (pdf-parse, mammoth, or direct)  │           │
│     │ • Split into ~500 char chunks                    │           │
│     │ • Store chunks in D1: org_context_chunks         │           │
│     └──────────────────────────────────────────────────┘           │
│                                │                                    │
│  4. Embed & Index             │                                    │
│                                ▼                                    │
│     ┌──────────────────────────────────────────────────┐           │
│     │ • Generate embeddings via Workers AI             │           │
│     │   (@cf/baai/bge-base-en-v1.5, 768 dimensions)   │           │
│     │ • Upsert to Vectorize with metadata:            │           │
│     │   { type: "org", org_id, source }               │           │
│     └──────────────────────────────────────────────────┘           │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

This enables RAG (Retrieval-Augmented Generation): when a user asks the bot a question, it searches Vectorize for relevant chunks, then includes them in the LLM prompt.

---

## Section 3: Step-by-Step Implementation

### 3.1 Project Setup

The web app scaffold already exists. Let's understand what we're working with:

```bash
# From the monorepo root
cd apps/web
npm install
```

**Key files:**

```
apps/web/
├── app/
│   ├── root.tsx              # App shell, global layout
│   ├── routes.ts             # Route definitions
│   └── routes/
│       └── _index.tsx        # Home page (/)
├── workers/
│   └── app.ts                # Cloudflare Workers entry point
├── react-router.config.ts    # React Router configuration
├── vite.config.ts            # Vite build configuration
└── wrangler.jsonc            # Cloudflare Pages configuration
```

### 3.2 Creating the Auth Client

First, we need a client to communicate with Better Auth on our API worker.

**Create `apps/web/app/lib/auth-client.ts`:**

```typescript
import { createAuthClient } from "better-auth/react";

// The baseURL points to your API worker
// In development, this runs on a different port
const getBaseURL = () => {
  if (typeof window === "undefined") {
    // Server-side: use environment variable
    return process.env.API_URL || "http://localhost:8787";
  }
  // Client-side: could be same-origin or cross-origin
  // For same-origin deployment, omit baseURL
  return import.meta.env.VITE_API_URL || "http://localhost:8787";
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
});

// Export commonly used hooks and functions
export const { useSession, signIn, signUp, signOut } = authClient;
```

**Why this matters:** Better Auth needs to know where to send requests. During development, your web app (`localhost:5173`) and API (`localhost:8787`) run on different ports. In production, you might deploy them to the same domain or different subdomains.

### 3.3 Building the Authentication UI

Let's create the signup page. This demonstrates:

- React Router 7's route module pattern
- Form handling with Better Auth
- Loading states and error handling

**Create `apps/web/app/routes/signup.tsx`:**

```typescript
import { useState } from "react";
import { useNavigate, Link } from "react-router";
import { authClient } from "~/lib/auth-client";

export default function SignUp() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    await authClient.signUp.email(
      { name, email, password },
      {
        onSuccess: () => {
          // Check for pending invitation, then redirect
          navigate("/dashboard");
        },
        onError: (ctx) => {
          setError(ctx.error.message);
          setIsLoading(false);
        },
      }
    );
  };

  const handleSocialSignIn = async (provider: "google" | "apple") => {
    setError(null);
    await authClient.signIn.social({ provider });
    // Social sign-in redirects, so no need to handle response here
  };

  return (
    <div className="auth-container">
      <h1>Create your Docket account</h1>

      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="name">Full name</label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
          />
        </div>

        <div className="form-group">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
          <span className="hint">At least 8 characters</span>
        </div>

        <button type="submit" disabled={isLoading}>
          {isLoading ? "Creating account..." : "Create account"}
        </button>
      </form>

      <div className="divider">or</div>

      <div className="social-buttons">
        <button
          type="button"
          onClick={() => handleSocialSignIn("google")}
          className="social-button google"
        >
          Continue with Google
        </button>
        <button
          type="button"
          onClick={() => handleSocialSignIn("apple")}
          className="social-button apple"
        >
          Continue with Apple
        </button>
      </div>

      <p className="auth-footer">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
```

**What's happening here:**

1. **`authClient.signUp.email`** — Sends a POST to `/api/auth/sign-up/email` on your API worker
2. **Callbacks** — `onSuccess` and `onError` let you handle the response
3. **Social sign-in** — `signIn.social` redirects to the OAuth provider (Google/Apple)
4. **No loader needed** — This is a pure client-side form; no server data required

### 3.4 Protected Routes with Session Loader

Most pages need to know if the user is logged in. React Router 7's loaders run on the server, so we can check the session there.

**Create `apps/web/app/routes/dashboard.tsx`:**

```typescript
import type { Route } from "./+types/dashboard";
import { redirect } from "react-router";

// This loader runs on the server (edge)
export async function loader({ request, context }: Route.LoaderArgs) {
  const { cloudflare } = context;

  // Forward the cookie to the API to validate session
  const response = await fetch(`${cloudflare.env.API_URL}/api/auth/get-session`, {
    headers: {
      cookie: request.headers.get("cookie") || "",
    },
  });

  if (!response.ok) {
    // Not logged in, redirect to login
    throw redirect("/login");
  }

  const session = await response.json();

  // Also fetch user's org membership
  const orgResponse = await fetch(`${cloudflare.env.API_URL}/api/user/org`, {
    headers: {
      cookie: request.headers.get("cookie") || "",
    },
  });

  const org = orgResponse.ok ? await orgResponse.json() : null;

  return { session, org };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { session, org } = loaderData;

  if (!org) {
    // User has no organization yet
    return (
      <div className="dashboard">
        <h1>Welcome, {session.user.name}!</h1>
        <p>You're not part of an organization yet.</p>
        <div className="options">
          <a href="/org/create" className="button primary">
            Create an organization
          </a>
          <p>Or wait for an invitation from your firm's admin.</p>
        </div>
      </div>
    );
  }

  // User has an organization
  return (
    <div className="dashboard">
      <h1>{org.name}</h1>
      <nav className="dashboard-nav">
        <a href="/org/settings">Settings</a>
        <a href="/org/members">Members</a>
        <a href="/org/documents">Documents</a>
        <a href="/org/clio">Clio Integration</a>
      </nav>
      {/* Dashboard content */}
    </div>
  );
}
```

**Understanding the loader:**

1. **Server-side execution** — Loaders run on Cloudflare's edge before rendering
2. **Cookie forwarding** — We pass the user's cookie to the API for session validation
3. **Redirect on failure** — If not authenticated, `throw redirect()` sends them to login
4. **Type safety** — `Route.LoaderArgs` and `Route.ComponentProps` are auto-generated

### 3.5 Organization Creation Flow

When a user creates an org, they become the Owner. Let's build this form:

**Create `apps/web/app/routes/org.create.tsx`:**

```typescript
import { useState } from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/org.create";
import { redirect } from "react-router";

// Available options (from spec)
const PRACTICE_TYPES = [
  "personal-injury-law",
  "family-law",
  "criminal-law",
  "immigration-law",
  "estate-planning",
  "business-law",
  "real-estate-law",
  "employment-law",
];

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const FIRM_SIZES = [
  { value: "solo", label: "Solo practitioner" },
  { value: "small", label: "Small firm (2-10 attorneys)" },
  { value: "mid", label: "Mid-size firm (11-50 attorneys)" },
  { value: "large", label: "Large firm (50+ attorneys)" },
];

// Loader: ensure user is logged in and doesn't already have an org
export async function loader({ request, context }: Route.LoaderArgs) {
  const { cloudflare } = context;

  const sessionRes = await fetch(`${cloudflare.env.API_URL}/api/auth/get-session`, {
    headers: { cookie: request.headers.get("cookie") || "" },
  });

  if (!sessionRes.ok) {
    throw redirect("/login");
  }

  const orgRes = await fetch(`${cloudflare.env.API_URL}/api/user/org`, {
    headers: { cookie: request.headers.get("cookie") || "" },
  });

  if (orgRes.ok) {
    // Already has an org, go to dashboard
    throw redirect("/dashboard");
  }

  return {};
}

export default function CreateOrganization() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form data
  const [orgType, setOrgType] = useState<"firm" | "clinic">("firm");
  const [name, setName] = useState("");
  const [jurisdictions, setJurisdictions] = useState<string[]>([]);
  const [practiceTypes, setPracticeTypes] = useState<string[]>([]);
  const [firmSize, setFirmSize] = useState<string>("small");

  const handleJurisdictionToggle = (state: string) => {
    setJurisdictions((prev) =>
      prev.includes(state)
        ? prev.filter((s) => s !== state)
        : [...prev, state]
    );
  };

  const handlePracticeTypeToggle = (type: string) => {
    setPracticeTypes((prev) =>
      prev.includes(type)
        ? prev.filter((t) => t !== type)
        : [...prev, type]
    );
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type: orgType,
          jurisdictions,
          practiceTypes,
          firmSize,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create organization");
      }

      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="org-creation">
      <h1>Create your organization</h1>

      {error && <div className="error-message">{error}</div>}

      {/* Step 1: Organization Type */}
      {step === 1 && (
        <div className="step">
          <h2>What type of organization?</h2>
          <div className="options">
            <button
              type="button"
              className={`option ${orgType === "firm" ? "selected" : ""}`}
              onClick={() => setOrgType("firm")}
            >
              <strong>Law Firm</strong>
              <span>Private practice</span>
            </button>
            <button
              type="button"
              className={`option ${orgType === "clinic" ? "selected" : ""}`}
              onClick={() => setOrgType("clinic")}
            >
              <strong>Legal Clinic</strong>
              <span>Non-profit or academic</span>
            </button>
          </div>
          <button onClick={() => setStep(2)}>Continue</button>
        </div>
      )}

      {/* Step 2: Basic Info */}
      {step === 2 && (
        <div className="step">
          <h2>Organization details</h2>
          <div className="form-group">
            <label htmlFor="name">Organization name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Smith & Associates"
              required
            />
          </div>
          <div className="form-group">
            <label>Firm size</label>
            <div className="radio-group">
              {FIRM_SIZES.map(({ value, label }) => (
                <label key={value} className="radio-option">
                  <input
                    type="radio"
                    name="firmSize"
                    value={value}
                    checked={firmSize === value}
                    onChange={(e) => setFirmSize(e.target.value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="button-group">
            <button type="button" onClick={() => setStep(1)}>Back</button>
            <button onClick={() => setStep(3)} disabled={!name}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Jurisdictions */}
      {step === 3 && (
        <div className="step">
          <h2>Where do you practice?</h2>
          <p className="hint">
            Select the states where you handle cases. This helps Docket provide
            relevant legal knowledge.
          </p>
          <div className="checkbox-grid">
            {US_STATES.map((state) => (
              <label key={state} className="checkbox-option">
                <input
                  type="checkbox"
                  checked={jurisdictions.includes(state)}
                  onChange={() => handleJurisdictionToggle(state)}
                />
                {state}
              </label>
            ))}
          </div>
          <div className="button-group">
            <button type="button" onClick={() => setStep(2)}>Back</button>
            <button onClick={() => setStep(4)} disabled={jurisdictions.length === 0}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Practice Areas */}
      {step === 4 && (
        <div className="step">
          <h2>What areas of law?</h2>
          <div className="checkbox-grid">
            {PRACTICE_TYPES.map((type) => (
              <label key={type} className="checkbox-option">
                <input
                  type="checkbox"
                  checked={practiceTypes.includes(type)}
                  onChange={() => handlePracticeTypeToggle(type)}
                />
                {type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </label>
            ))}
          </div>
          <div className="button-group">
            <button type="button" onClick={() => setStep(3)}>Back</button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || practiceTypes.length === 0}
            >
              {isSubmitting ? "Creating..." : "Create Organization"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Why multi-step?**

- Reduces cognitive load
- Each piece of information has context
- Users understand why we're asking

**What happens on submit:**

1. POST to `/api/org` creates the org in D1
2. Current user becomes Owner (`is_owner: true`, role: "admin")
3. A Durable Object is instantiated with the org ID

### 3.6 Member Invitation System

Admins invite members by email. The invitation flow:

```
┌────────────────────────────────────────────────────────────────────┐
│                    Invitation Flow                                  │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   1. Admin sends invitation                                        │
│      ┌──────────────────┐         ┌──────────────────┐            │
│      │ Email: jane@...  │────────►│ D1: invitations  │            │
│      │ Role: member     │         │ status: pending  │            │
│      └──────────────────┘         └──────────────────┘            │
│                                            │                       │
│   2. Email sent to invitee                │                       │
│      ┌──────────────────────────────────────────────────┐         │
│      │ "John invited you to join Smith & Associates"   │         │
│      │ [Accept Invitation]                              │         │
│      └──────────────────────────────────────────────────┘         │
│                                            │                       │
│   3. Invitee clicks link                  │                       │
│      ┌──────────────────┐                 ▼                       │
│      │ /invite/{code}   │─────────────────┐                       │
│      └──────────────────┘                 │                       │
│                                            │                       │
│   4a. Has account?                        │                       │
│       ├─ Yes: Link to org                 │                       │
│       └─ No: Show signup, then link       │                       │
│                                            │                       │
│   5. Update invitation status             ▼                       │
│      ┌──────────────────┐         ┌──────────────────┐            │
│      │ D1: org_members  │◄────────│ status: accepted │            │
│      │ user + org + role│         └──────────────────┘            │
│      └──────────────────┘                                          │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Create `apps/web/app/routes/org.members.tsx`:**

```typescript
import { useState } from "react";
import type { Route } from "./+types/org.members";
import { redirect } from "react-router";

interface Member {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  isOwner: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "expired";
  createdAt: string;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { cloudflare } = context;
  const cookie = request.headers.get("cookie") || "";

  // Verify session and get org
  const [sessionRes, orgRes] = await Promise.all([
    fetch(`${cloudflare.env.API_URL}/api/auth/get-session`, {
      headers: { cookie },
    }),
    fetch(`${cloudflare.env.API_URL}/api/user/org`, {
      headers: { cookie },
    }),
  ]);

  if (!sessionRes.ok || !orgRes.ok) {
    throw redirect("/login");
  }

  const session = await sessionRes.json();
  const org = await orgRes.json();

  // Check if user is admin
  if (org.role !== "admin") {
    throw redirect("/dashboard"); // Members can't manage members
  }

  // Fetch members and pending invitations
  const [membersRes, invitationsRes] = await Promise.all([
    fetch(`${cloudflare.env.API_URL}/api/org/members`, {
      headers: { cookie },
    }),
    fetch(`${cloudflare.env.API_URL}/api/org/invitations`, {
      headers: { cookie },
    }),
  ]);

  const members = await membersRes.json();
  const invitations = await invitationsRes.json();

  return { session, org, members, invitations };
}

export default function MembersPage({ loaderData }: Route.ComponentProps) {
  const { session, org, members, invitations } = loaderData;
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [isInviting, setIsInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsInviting(true);
    setError(null);

    try {
      const response = await fetch("/api/org/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to send invitation");
      }

      // Reset form and refresh page
      setInviteEmail("");
      setShowInviteForm(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!confirm("Are you sure you want to remove this member?")) return;

    try {
      await fetch(`/api/org/members/${userId}`, { method: "DELETE" });
      window.location.reload();
    } catch (err) {
      alert("Failed to remove member");
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    try {
      await fetch(`/api/org/invitations/${invitationId}`, { method: "DELETE" });
      window.location.reload();
    } catch (err) {
      alert("Failed to cancel invitation");
    }
  };

  return (
    <div className="members-page">
      <header>
        <h1>Team Members</h1>
        <button onClick={() => setShowInviteForm(true)}>Invite Member</button>
      </header>

      {error && <div className="error-message">{error}</div>}

      {/* Invite Modal */}
      {showInviteForm && (
        <div className="modal-backdrop" onClick={() => setShowInviteForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Invite a team member</h2>
            <form onSubmit={handleInvite}>
              <div className="form-group">
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Role</label>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      name="role"
                      value="member"
                      checked={inviteRole === "member"}
                      onChange={() => setInviteRole("member")}
                    />
                    <div>
                      <strong>Member</strong>
                      <span>Can query Clio data (read-only)</span>
                    </div>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="role"
                      value="admin"
                      checked={inviteRole === "admin"}
                      onChange={() => setInviteRole("admin")}
                    />
                    <div>
                      <strong>Admin</strong>
                      <span>Can modify Clio data and manage settings</span>
                    </div>
                  </label>
                </div>
              </div>
              <div className="button-group">
                <button type="button" onClick={() => setShowInviteForm(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={isInviting}>
                  {isInviting ? "Sending..." : "Send Invitation"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Current Members */}
      <section>
        <h2>Current Members ({members.length})</h2>
        <table className="members-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member: Member) => (
              <tr key={member.id}>
                <td>
                  {member.name}
                  {member.isOwner && <span className="badge">Owner</span>}
                </td>
                <td>{member.email}</td>
                <td>{member.role}</td>
                <td>
                  {!member.isOwner && member.id !== session.user.id && (
                    <button
                      onClick={() => handleRemoveMember(member.id)}
                      className="button-danger"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Pending Invitations */}
      {invitations.filter((i: Invitation) => i.status === "pending").length > 0 && (
        <section>
          <h2>Pending Invitations</h2>
          <table className="members-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Sent</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations
                .filter((i: Invitation) => i.status === "pending")
                .map((invitation: Invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{invitation.role}</td>
                    <td>{new Date(invitation.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        onClick={() => handleCancelInvitation(invitation.id)}
                        className="button-secondary"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
```

### 3.7 Clio OAuth Connection

Users connect their individual Clio accounts. This is handled by the API worker, but the web app provides the UI:

**Create `apps/web/app/routes/org.clio.tsx`:**

```typescript
import type { Route } from "./+types/org.clio";
import { redirect } from "react-router";

interface ClioStatus {
  connected: boolean;
  email?: string;
  connectedAt?: string;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { cloudflare } = context;
  const cookie = request.headers.get("cookie") || "";

  const [sessionRes, clioRes] = await Promise.all([
    fetch(`${cloudflare.env.API_URL}/api/auth/get-session`, {
      headers: { cookie },
    }),
    fetch(`${cloudflare.env.API_URL}/api/clio/status`, {
      headers: { cookie },
    }),
  ]);

  if (!sessionRes.ok) {
    throw redirect("/login");
  }

  const session = await sessionRes.json();
  const clioStatus: ClioStatus = await clioRes.json();

  return { session, clioStatus };
}

export default function ClioIntegration({ loaderData }: Route.ComponentProps) {
  const { session, clioStatus } = loaderData;

  const handleConnect = () => {
    // Redirect to API's Clio OAuth start endpoint
    window.location.href = "/api/clio/connect";
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect your Clio account? You'll need to reconnect to use Docket with Clio.")) {
      return;
    }

    await fetch("/api/clio/disconnect", { method: "POST" });
    window.location.reload();
  };

  const handleRefreshSchema = async () => {
    // Admin-only: refresh Clio schema cache
    try {
      await fetch("/api/clio/refresh-schema", { method: "POST" });
      alert("Schema refreshed successfully");
    } catch {
      alert("Failed to refresh schema");
    }
  };

  return (
    <div className="clio-page">
      <h1>Clio Integration</h1>

      {clioStatus.connected ? (
        <div className="status-connected">
          <div className="status-header">
            <span className="status-indicator connected" />
            <h2>Connected to Clio</h2>
          </div>
          <dl>
            <dt>Clio Account</dt>
            <dd>{clioStatus.email}</dd>
            <dt>Connected</dt>
            <dd>{new Date(clioStatus.connectedAt!).toLocaleDateString()}</dd>
          </dl>
          <div className="actions">
            <button onClick={handleRefreshSchema} className="button-secondary">
              Refresh Schema
            </button>
            <button onClick={handleDisconnect} className="button-danger">
              Disconnect
            </button>
          </div>
          <p className="hint">
            <strong>Refresh Schema:</strong> Click this if you've added custom fields
            in Clio and want Docket to recognize them.
          </p>
        </div>
      ) : (
        <div className="status-disconnected">
          <div className="status-header">
            <span className="status-indicator disconnected" />
            <h2>Not Connected</h2>
          </div>
          <p>
            Connect your Clio account to let Docket access your case information,
            contacts, and calendar.
          </p>
          <button onClick={handleConnect} className="button-primary">
            Connect Clio Account
          </button>
        </div>
      )}

      <section className="info-section">
        <h3>What can Docket do with Clio?</h3>
        <ul>
          <li><strong>Read:</strong> Query matters, contacts, tasks, calendar entries</li>
          <li><strong>Write (Admins only):</strong> Create/update records with your confirmation</li>
        </ul>
        <p>
          Each team member connects their own Clio account. Docket respects
          Clio's permissions—you'll only see what you can see in Clio directly.
        </p>
      </section>
    </div>
  );
}
```

**How Clio OAuth works:**

1. User clicks "Connect Clio Account"
2. Redirects to `/api/clio/connect` on API worker
3. API generates PKCE challenge + signed state, redirects to Clio
4. User approves in Clio, redirects back to `/api/clio/callback`
5. API exchanges code for tokens, stores encrypted in DO Storage
6. Redirects back to web app with success message

### 3.8 Document Upload (Org Context)

This is the most complex UI component. Admins upload documents that become part of the RAG context.

**Create `apps/web/app/routes/org.documents.tsx`:**

```typescript
import { useState, useRef } from "react";
import type { Route } from "./+types/org.documents";
import { redirect } from "react-router";

interface Document {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  chunkCount: number;
}

const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
];

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export async function loader({ request, context }: Route.LoaderArgs) {
  const { cloudflare } = context;
  const cookie = request.headers.get("cookie") || "";

  const [sessionRes, orgRes, docsRes] = await Promise.all([
    fetch(`${cloudflare.env.API_URL}/api/auth/get-session`, {
      headers: { cookie },
    }),
    fetch(`${cloudflare.env.API_URL}/api/user/org`, {
      headers: { cookie },
    }),
    fetch(`${cloudflare.env.API_URL}/api/org/documents`, {
      headers: { cookie },
    }),
  ]);

  if (!sessionRes.ok || !orgRes.ok) {
    throw redirect("/login");
  }

  const session = await sessionRes.json();
  const org = await orgRes.json();

  if (org.role !== "admin") {
    throw redirect("/dashboard");
  }

  const documents = await docsRes.json();

  return { session, org, documents };
}

export default function DocumentsPage({ loaderData }: Route.ComponentProps) {
  const { documents: initialDocs } = loaderData;
  const [documents, setDocuments] = useState<Document[]>(initialDocs);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return `File type "${file.type}" is not supported. Use PDF, DOCX, or Markdown.`;
    }
    if (file.size > MAX_SIZE) {
      return `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 25MB.`;
    }
    return null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", file);

      // Use fetch with no progress tracking (simpler)
      const response = await fetch("/api/org/documents", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Upload failed");
      }

      const newDoc = await response.json();
      setDocuments((prev) => [newDoc, ...prev]);
      setUploadProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleDelete = async (docId: string, filename: string) => {
    if (!confirm(`Delete "${filename}"? This will remove it from Docket's knowledge base.`)) {
      return;
    }

    try {
      await fetch(`/api/org/documents/${docId}`, { method: "DELETE" });
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
    } catch {
      alert("Failed to delete document");
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="documents-page">
      <header>
        <h1>Org Context Documents</h1>
        <p>
          Upload your firm's internal documents. Docket will use them to answer
          questions about your procedures and policies.
        </p>
      </header>

      {error && <div className="error-message">{error}</div>}

      {/* Upload Area */}
      <div className="upload-area">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.md,.txt"
          onChange={handleFileSelect}
          disabled={uploading}
          id="file-input"
          className="visually-hidden"
        />
        <label htmlFor="file-input" className="upload-label">
          {uploading ? (
            <div className="upload-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <span>Processing document...</span>
            </div>
          ) : (
            <>
              <span className="upload-icon">📄</span>
              <span>Drop a file here or click to upload</span>
              <span className="upload-hint">PDF, DOCX, or Markdown (max 25MB)</span>
            </>
          )}
        </label>
      </div>

      {/* Document List */}
      <section>
        <h2>Uploaded Documents ({documents.length})</h2>
        {documents.length === 0 ? (
          <p className="empty-state">
            No documents uploaded yet. Upload your firm's procedures,
            templates, or policies to enhance Docket's responses.
          </p>
        ) : (
          <table className="documents-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th>Chunks</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.filename}</td>
                  <td>{formatFileSize(doc.size)}</td>
                  <td>{doc.chunkCount}</td>
                  <td>{new Date(doc.uploadedAt).toLocaleDateString()}</td>
                  <td>
                    <button
                      onClick={() => handleDelete(doc.id, doc.filename)}
                      className="button-danger"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Info Section */}
      <section className="info-section">
        <h3>How Org Context works</h3>
        <ol>
          <li>Upload a document (PDF, DOCX, Markdown)</li>
          <li>Docket extracts the text and splits it into chunks</li>
          <li>Each chunk is converted to a vector embedding</li>
          <li>When users ask questions, Docket searches for relevant chunks</li>
          <li>Relevant chunks are included in the AI's context</li>
        </ol>
        <p>
          <strong>Tip:</strong> Upload procedural documents, templates,
          client intake checklists, and internal policies. Avoid uploading
          sensitive client data or privileged communications.
        </p>
      </section>
    </div>
  );
}
```

**What happens on upload:**

1. File validation (type, size) in browser
2. FormData POST to `/api/org/documents`
3. API validates again (MIME, magic bytes, sanitizes filename)
4. Raw file stored in R2: `/orgs/{org_id}/docs/{file_id}`
5. Text extracted (pdf-parse, mammoth, or direct)
6. Text chunked (~500 chars each)
7. Chunks stored in D1: `org_context_chunks`
8. Embeddings generated via Workers AI
9. Embeddings upserted to Vectorize with `{ type: "org", org_id }`

---

## Section 4: Testing Strategy

### 4.1 Unit Tests

Unit tests focus on isolated logic—validation, formatting, state management.

**Create `apps/web/app/lib/__tests__/validation.test.ts`:**

```typescript
import { describe, it, expect } from "vitest";

// Example validation functions to test
const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
];

const MAX_SIZE = 25 * 1024 * 1024;

function validateFile(file: { type: string; size: number }): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return `File type "${file.type}" is not supported.`;
  }
  if (file.size > MAX_SIZE) {
    return `File is too large.`;
  }
  return null;
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 255);
}

describe("File Validation", () => {
  it("accepts valid PDF files", () => {
    const result = validateFile({
      type: "application/pdf",
      size: 1024 * 1024,
    });
    expect(result).toBeNull();
  });

  it("rejects unsupported file types", () => {
    const result = validateFile({
      type: "application/zip",
      size: 1024,
    });
    expect(result).toContain("not supported");
  });

  it("rejects files over 25MB", () => {
    const result = validateFile({
      type: "application/pdf",
      size: 30 * 1024 * 1024,
    });
    expect(result).toContain("too large");
  });
});

describe("Filename Sanitization", () => {
  it("removes special characters", () => {
    expect(sanitizeFilename("file<>name.pdf")).toBe("file__name.pdf");
  });

  it("prevents path traversal", () => {
    expect(sanitizeFilename("../../../etc/passwd")).toBe(
      "_.._.._.._etc_passwd"
    );
  });

  it("removes double extensions", () => {
    expect(sanitizeFilename("file..exe.pdf")).toBe("file.exe.pdf");
  });

  it("truncates long filenames", () => {
    const longName = "a".repeat(300) + ".pdf";
    expect(sanitizeFilename(longName).length).toBeLessThanOrEqual(255);
  });
});
```

### 4.2 Integration Tests

Integration tests verify the web app works correctly with the API. These run against a local dev server.

**Create `apps/web/test/integration/auth-flow.spec.ts`:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const API_URL = process.env.API_URL || "http://localhost:8787";
const WEB_URL = process.env.WEB_URL || "http://localhost:5173";

describe("Authentication Flow", () => {
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = "SecurePassword123!";
  let sessionCookie: string;

  it("creates a new account", async () => {
    const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        name: "Test User",
      }),
    });

    expect(response.ok).toBe(true);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    sessionCookie = setCookie!.split(";")[0];
  });

  it("retrieves session with cookie", async () => {
    const response = await fetch(`${API_URL}/api/auth/get-session`, {
      headers: { cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);

    const session = await response.json();
    expect(session.user.email).toBe(testEmail);
  });

  it("fails to access protected route without session", async () => {
    const response = await fetch(`${API_URL}/api/user/org`);
    expect(response.status).toBe(401);
  });

  it("signs out successfully", async () => {
    const response = await fetch(`${API_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: sessionCookie },
    });

    expect(response.ok).toBe(true);
  });
});
```

### 4.3 End-to-End Tests

E2E tests simulate real user interactions using Playwright.

**Create `apps/web/test/e2e/signup-flow.spec.ts`:**

```typescript
import { test, expect } from "@playwright/test";

test.describe("Signup Flow", () => {
  const testEmail = `e2e-${Date.now()}@example.com`;

  test("user can sign up and create an organization", async ({ page }) => {
    // Navigate to signup
    await page.goto("/signup");
    await expect(page).toHaveTitle(/Docket/);

    // Fill signup form
    await page.fill('input[type="text"]', "E2E Test User");
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', "SecurePassword123!");
    await page.click('button[type="submit"]');

    // Should redirect to dashboard
    await expect(page).toHaveURL(/dashboard/);
    await expect(
      page.locator("text=not part of an organization")
    ).toBeVisible();

    // Click create organization
    await page.click("text=Create an organization");
    await expect(page).toHaveURL(/org\/create/);

    // Step 1: Org type
    await page.click("text=Law Firm");
    await page.click("text=Continue");

    // Step 2: Basic info
    await page.fill('input[type="text"]', "E2E Test Firm");
    await page.click("text=Small firm");
    await page.click("text=Continue");

    // Step 3: Jurisdictions
    await page.click("text=CA");
    await page.click("text=NY");
    await page.click("text=Continue");

    // Step 4: Practice areas
    await page.click("text=Family Law");
    await page.click("text=Create Organization");

    // Should redirect to dashboard with org
    await expect(page).toHaveURL(/dashboard/);
    await expect(page.locator("text=E2E Test Firm")).toBeVisible();
  });

  test("user can invite a team member", async ({ page }) => {
    // Login first (assuming test user from previous test)
    await page.goto("/login");
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', "SecurePassword123!");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/dashboard/);

    // Navigate to members
    await page.click("text=Members");
    await expect(page).toHaveURL(/org\/members/);

    // Open invite modal
    await page.click("text=Invite Member");
    await expect(page.locator("text=Invite a team member")).toBeVisible();

    // Fill invitation form
    await page.fill('input[type="email"]', "invited@example.com");
    await page.click("text=Send Invitation");

    // Should see pending invitation
    await expect(page.locator("text=invited@example.com")).toBeVisible();
    await expect(page.locator("text=pending")).toBeVisible();
  });
});
```

### 4.4 Running Tests

Add these scripts to `apps/web/package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "INTEGRATION=true vitest run test/integration",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

---

## Section 5: Shareholder Demo Component

The demo should clearly demonstrate each capability built in Phase 9. This component shows the full flow in a self-contained, visually clear way.

**Create `apps/web/app/routes/demo.tsx`:**

```typescript
import { useState } from "react";
import type { Route } from "./+types/demo";

type DemoStep =
  | "intro"
  | "signup"
  | "create-org"
  | "invite"
  | "clio"
  | "documents"
  | "complete";

interface DemoState {
  user: { name: string; email: string } | null;
  org: { name: string; members: string[] } | null;
  clioConnected: boolean;
  documents: string[];
}

export default function DemoPage() {
  const [step, setStep] = useState<DemoStep>("intro");
  const [demoState, setDemoState] = useState<DemoState>({
    user: null,
    org: null,
    clioConnected: false,
    documents: [],
  });

  const renderStep = () => {
    switch (step) {
      case "intro":
        return (
          <div className="demo-step">
            <h2>Phase 9: Website MVP Demo</h2>
            <p>
              This demo walks through the complete user journey for setting up
              a law firm on Docket. Each step represents a key capability built
              in Phase 9.
            </p>
            <div className="capabilities-list">
              <h3>Capabilities Demonstrated:</h3>
              <ol>
                <li>User authentication (email + social SSO)</li>
                <li>Organization creation with practice settings</li>
                <li>Team member invitation system</li>
                <li>Clio OAuth integration</li>
                <li>Org Context document upload</li>
              </ol>
            </div>
            <button onClick={() => setStep("signup")} className="demo-button">
              Start Demo →
            </button>
          </div>
        );

      case "signup":
        return (
          <div className="demo-step">
            <h2>Step 1: User Signup</h2>
            <div className="demo-context">
              <p>
                <strong>What's happening:</strong> A new user creates their
                Docket account using email/password or social SSO (Google/Apple).
              </p>
              <p>
                <strong>Behind the scenes:</strong> Better Auth handles registration,
                password hashing (PBKDF2), and session creation in D1.
              </p>
            </div>
            <div className="demo-simulation">
              <div className="mock-form">
                <div className="form-field">
                  <label>Name</label>
                  <input type="text" value="Sarah Chen" readOnly />
                </div>
                <div className="form-field">
                  <label>Email</label>
                  <input type="email" value="sarah@smithlaw.com" readOnly />
                </div>
                <div className="form-field">
                  <label>Password</label>
                  <input type="password" value="••••••••••" readOnly />
                </div>
                <button
                  onClick={() => {
                    setDemoState({
                      ...demoState,
                      user: { name: "Sarah Chen", email: "sarah@smithlaw.com" },
                    });
                    setStep("create-org");
                  }}
                >
                  Create Account
                </button>
              </div>
              <div className="social-divider">or</div>
              <div className="social-buttons">
                <button className="google">Continue with Google</button>
                <button className="apple">Continue with Apple</button>
              </div>
            </div>
          </div>
        );

      case "create-org":
        return (
          <div className="demo-step">
            <h2>Step 2: Create Organization</h2>
            <div className="demo-context">
              <p>
                <strong>What's happening:</strong> {demoState.user?.name} creates
                their law firm organization with practice details.
              </p>
              <p>
                <strong>Behind the scenes:</strong> A new org is created in D1,
                a Durable Object is instantiated (org_id = DO ID), and the user
                becomes Owner with admin role.
              </p>
            </div>
            <div className="demo-simulation">
              <div className="org-preview">
                <h3>Smith & Chen LLP</h3>
                <dl>
                  <dt>Type</dt>
                  <dd>Law Firm</dd>
                  <dt>Size</dt>
                  <dd>Small (2-10 attorneys)</dd>
                  <dt>Jurisdictions</dt>
                  <dd>California, New York</dd>
                  <dt>Practice Areas</dt>
                  <dd>Family Law, Estate Planning</dd>
                </dl>
              </div>
              <button
                onClick={() => {
                  setDemoState({
                    ...demoState,
                    org: { name: "Smith & Chen LLP", members: ["Sarah Chen (Owner)"] },
                  });
                  setStep("invite");
                }}
              >
                Create Organization
              </button>
            </div>
          </div>
        );

      case "invite":
        return (
          <div className="demo-step">
            <h2>Step 3: Invite Team Members</h2>
            <div className="demo-context">
              <p>
                <strong>What's happening:</strong> Sarah invites her colleagues
                to join the organization.
              </p>
              <p>
                <strong>Behind the scenes:</strong> Invitations are stored in D1
                with email + role + org_id. When invitees sign up, the system
                checks for matching invitations and links them to the org.
              </p>
            </div>
            <div className="demo-simulation">
              <div className="member-list">
                <h3>Current Team</h3>
                <ul>
                  {demoState.org?.members.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
              <div className="invite-form">
                <h3>Invite New Member</h3>
                <div className="form-field">
                  <label>Email</label>
                  <input type="email" value="mike@smithlaw.com" readOnly />
                </div>
                <div className="form-field">
                  <label>Role</label>
                  <select defaultValue="member">
                    <option value="member">Member (read-only)</option>
                    <option value="admin">Admin (full access)</option>
                  </select>
                </div>
                <button
                  onClick={() => {
                    setDemoState({
                      ...demoState,
                      org: {
                        ...demoState.org!,
                        members: [...demoState.org!.members, "Mike Smith (Member) - Invited"],
                      },
                    });
                  }}
                >
                  Send Invitation
                </button>
              </div>
              <button onClick={() => setStep("clio")} className="demo-next">
                Continue to Clio Setup →
              </button>
            </div>
          </div>
        );

      case "clio":
        return (
          <div className="demo-step">
            <h2>Step 4: Connect Clio</h2>
            <div className="demo-context">
              <p>
                <strong>What's happening:</strong> Sarah connects her personal
                Clio account to Docket.
              </p>
              <p>
                <strong>Behind the scenes:</strong> OAuth flow with PKCE. Tokens
                are encrypted (AES-GCM) with per-user key derivation and stored
                in the org's Durable Object. First connection triggers Clio schema
                provisioning.
              </p>
            </div>
            <div className="demo-simulation">
              {!demoState.clioConnected ? (
                <div className="clio-disconnected">
                  <div className="status-badge disconnected">Not Connected</div>
                  <p>Connect your Clio account to access case information through Docket.</p>
                  <button
                    onClick={() => {
                      setDemoState({ ...demoState, clioConnected: true });
                    }}
                    className="clio-connect"
                  >
                    Connect Clio Account
                  </button>
                </div>
              ) : (
                <div className="clio-connected">
                  <div className="status-badge connected">Connected</div>
                  <dl>
                    <dt>Clio Account</dt>
                    <dd>sarah@smithlaw.com</dd>
                    <dt>Connected At</dt>
                    <dd>{new Date().toLocaleDateString()}</dd>
                  </dl>
                  <p className="success-message">
                    ✓ Clio schema cached (15 object types, 127 fields)
                  </p>
                </div>
              )}
              <button
                onClick={() => setStep("documents")}
                className="demo-next"
                disabled={!demoState.clioConnected}
              >
                Continue to Documents →
              </button>
            </div>
          </div>
        );

      case "documents":
        return (
          <div className="demo-step">
            <h2>Step 5: Upload Org Context</h2>
            <div className="demo-context">
              <p>
                <strong>What's happening:</strong> Sarah uploads her firm's
                internal procedures so Docket can reference them.
              </p>
              <p>
                <strong>Behind the scenes:</strong> Files stored in R2, text
                extracted and chunked, embeddings generated via Workers AI
                (@cf/baai/bge-base-en-v1.5), indexed in Vectorize for RAG retrieval.
              </p>
            </div>
            <div className="demo-simulation">
              <div className="upload-zone">
                <span className="upload-icon">📄</span>
                <span>Drop files here or click to upload</span>
              </div>
              <div className="demo-files">
                {demoState.documents.length === 0 ? (
                  <button
                    onClick={() => {
                      setDemoState({
                        ...demoState,
                        documents: [
                          "Client Intake Procedures.pdf (12 chunks)",
                          "Fee Agreement Template.docx (8 chunks)",
                          "Firm Billing Rates 2024.md (3 chunks)",
                        ],
                      });
                    }}
                  >
                    Simulate Upload
                  </button>
                ) : (
                  <div className="uploaded-files">
                    <h3>Uploaded Documents</h3>
                    <ul>
                      {demoState.documents.map((doc) => (
                        <li key={doc}>✓ {doc}</li>
                      ))}
                    </ul>
                    <p className="success-message">
                      23 text chunks indexed in Vectorize
                    </p>
                  </div>
                )}
              </div>
              <button
                onClick={() => setStep("complete")}
                className="demo-next"
                disabled={demoState.documents.length === 0}
              >
                Complete Demo →
              </button>
            </div>
          </div>
        );

      case "complete":
        return (
          <div className="demo-step demo-complete">
            <h2>✓ Phase 9 Complete!</h2>
            <div className="summary">
              <h3>What We Built:</h3>
              <table className="summary-table">
                <tbody>
                  <tr>
                    <td>User</td>
                    <td>{demoState.user?.name} ({demoState.user?.email})</td>
                  </tr>
                  <tr>
                    <td>Organization</td>
                    <td>{demoState.org?.name}</td>
                  </tr>
                  <tr>
                    <td>Team</td>
                    <td>{demoState.org?.members.length} members</td>
                  </tr>
                  <tr>
                    <td>Clio</td>
                    <td>{demoState.clioConnected ? "Connected" : "Not connected"}</td>
                  </tr>
                  <tr>
                    <td>Documents</td>
                    <td>{demoState.documents.length} files uploaded</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="next-phase">
              <h3>Ready for Phase 10: Teams Adapter</h3>
              <p>
                With the website MVP complete, users can set up their organizations.
                Phase 10 adds the Microsoft Teams bot so they can actually chat
                with Docket.
              </p>
            </div>
            <button onClick={() => setStep("intro")} className="demo-restart">
              Restart Demo
            </button>
          </div>
        );
    }
  };

  return (
    <div className="demo-page">
      <header className="demo-header">
        <h1>Docket</h1>
        <span className="demo-badge">Shareholder Demo</span>
      </header>

      <div className="demo-progress">
        {["intro", "signup", "create-org", "invite", "clio", "documents", "complete"].map(
          (s, i) => (
            <div
              key={s}
              className={`progress-step ${step === s ? "active" : ""} ${
                ["intro", "signup", "create-org", "invite", "clio", "documents", "complete"].indexOf(step) > i
                  ? "complete"
                  : ""
              }`}
            >
              {i > 0 && i < 6 ? i : ""}
            </div>
          )
        )}
      </div>

      <main className="demo-content">{renderStep()}</main>
    </div>
  );
}
```

**Add demo-specific styles in `apps/web/app/styles/demo.css`:**

```css
.demo-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: #fff;
  padding: 2rem;
}

.demo-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 2rem;
}

.demo-badge {
  background: #e94560;
  padding: 0.25rem 0.75rem;
  border-radius: 1rem;
  font-size: 0.875rem;
}

.demo-progress {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  margin-bottom: 2rem;
}

.progress-step {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: #333;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.875rem;
}

.progress-step.active {
  background: #e94560;
}

.progress-step.complete {
  background: #4ade80;
}

.demo-step {
  max-width: 800px;
  margin: 0 auto;
  background: #1f2937;
  padding: 2rem;
  border-radius: 1rem;
}

.demo-context {
  background: #374151;
  padding: 1rem;
  border-radius: 0.5rem;
  margin-bottom: 1.5rem;
}

.demo-context p {
  margin: 0.5rem 0;
}

.demo-simulation {
  padding: 1.5rem;
  background: #fff;
  color: #1a1a2e;
  border-radius: 0.5rem;
}

.demo-button,
.demo-next {
  background: #e94560;
  color: #fff;
  border: none;
  padding: 1rem 2rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 1rem;
  margin-top: 1rem;
}

.demo-button:hover,
.demo-next:hover {
  background: #d63850;
}

.demo-next:disabled {
  background: #666;
  cursor: not-allowed;
}

.status-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 1rem;
  font-size: 0.875rem;
}

.status-badge.connected {
  background: #4ade80;
  color: #000;
}

.status-badge.disconnected {
  background: #ef4444;
}

.success-message {
  color: #4ade80;
  margin-top: 1rem;
}

.summary-table {
  width: 100%;
  border-collapse: collapse;
}

.summary-table td {
  padding: 0.5rem;
  border-bottom: 1px solid #374151;
}

.summary-table td:first-child {
  font-weight: bold;
  width: 150px;
}
```

---

## Summary: Phase 9 Checklist

Use this checklist to track your progress:

```
□ Web app wrangler config (CORS, trustedOrigins)
□ Auth client setup (Better Auth React client)
□ Auth UI (signup, login, social SSO)
□ Invitation signup flow
□ Org creation flow (type, practice areas, location, name)
□ Creator becomes Owner
□ Org settings dashboard
□ Member invitation UI (email + role)
□ Ownership transfer
□ Clio connect flow (OAuth redirect)
□ Clio schema refresh button (Admin only)
□ Org Context upload UI
□ Org Context management (list, delete)
□ Audit log PII redaction
□ Unit tests passing
□ Integration tests passing
□ E2E tests passing
□ Demo deployed
```

---

## Next Steps

Phase 9 gives users everything they need to set up their organization. Phase 10 (Teams Adapter) will add the primary user interface—the Microsoft Teams bot that lets them actually chat with Docket.

Key dependencies satisfied:

- Users can sign up and create accounts
- Organizations exist with roles and permissions
- Clio OAuth tokens are stored
- Org Context documents are indexed
- Invitation system works

The foundation is ready for the chatbot.
