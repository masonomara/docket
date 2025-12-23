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

- The baseURL points to your API worker
- In development, this runs on a different port
  - Server-side: use environment variable
  - Client-side: could be same-origin or cross-origin
  - For same-origin deployment, omit baseURL
- Export commonly used hooks and functions

**Why this matters:** Better Auth needs to know where to send requests. During development, your web app (`localhost:5173`) and API (`localhost:8787`) run on different ports. In production, you might deploy them to the same domain or different subdomains.

### 3.3 Building the Authentication UI

Let's create the signup page. This demonstrates:

- React Router 7's route module pattern
- Form handling with Better Auth
- Loading states and error handling

**Create `apps/web/app/routes/signup.tsx`:**

- Form state
  - Check for pending invitation, then redirect
  - Social sign-in redirects, so no need to handle response here

**What's happening here:**

1. **`authClient.signUp.email`** — Sends a POST to `/api/auth/sign-up/email` on your API worker
2. **Callbacks** — `onSuccess` and `onError` let you handle the response
3. **Social sign-in** — `signIn.social` redirects to the OAuth provider (Google/Apple)
4. **No loader needed** — This is a pure client-side form; no server data required

### 3.4 Protected Routes with Session Loader

Most pages need to know if the user is logged in. React Router 7's loaders run on the server, so we can check the session there.

**Create `apps/web/app/routes/dashboard.tsx`:**

- This loader runs on the server (edge)
  - Forward the cookie to the API to validate session
    - Not logged in, redirect to login
  - Also fetch user's org membership
    - User has no organization yet
  - User has an organization
    - Dashboard content

**Understanding the loader:**

1. **Server-side execution** — Loaders run on Cloudflare's edge before rendering
2. **Cookie forwarding** — We pass the user's cookie to the API for session validation
3. **Redirect on failure** — If not authenticated, `throw redirect()` sends them to login
4. **Type safety** — `Route.LoaderArgs` and `Route.ComponentProps` are auto-generated

### 3.5 Organization Creation Flow

When a user creates an org, they become the Owner. Let's build this form:

**Create `apps/web/app/routes/org.create.tsx`:**

- Available options (from spec)

- Loader: ensure user is logged in and doesn't already have an org
  - Already has an org, go to dashboard
  - Form data
    - Step 1: Organization Type
    - Step 2: Basic Info
    - Step 3: Jurisdictions
    - Step 4: Practice Areas

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

- Verify session and get org
- Check if user is admin
- Fetch members and pending invitations
  - Reset form and refresh page
    - Current Members
    - Pending Invitations

### 3.7 Clio OAuth Connection

Users connect their individual Clio accounts. This is handled by the API worker, but the web app provides the UI:

**Create `apps/web/app/routes/org.clio.tsx`:**

````typescript

    // Redirect to API's Clio OAuth start endpoint

    // Admin-only: refresh Clio schema cache


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
````

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

**Create `apps/web/app/routes/demo.tsx`**

**Add demo-specific styles in `apps/web/app/styles/demo.css`**

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
