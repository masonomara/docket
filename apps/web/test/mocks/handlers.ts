import { http, HttpResponse } from "msw";

// Match the VITE_API_URL from .env (used in tests)
const API_URL = "http://localhost:8787";

// Mock data
export const mockUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  emailVerified: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const mockSession = {
  session: {
    id: "sess-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  },
  user: mockUser,
};

export const mockOrg = {
  org: {
    id: "org-1",
    name: "Test Firm",
    type: "law_firm",
  },
  role: "admin" as const,
  isOwner: true,
};

export const mockInvitation = {
  id: "inv-1",
  email: "invite@example.com",
  orgName: "Test Firm",
  role: "member" as const,
  inviterName: "Admin User",
  isExpired: false,
  isAccepted: false,
};

// Default handlers (authenticated state)
export const handlers = [
  // Session
  http.get(`${API_URL}/api/auth/get-session`, () => {
    return HttpResponse.json(mockSession);
  }),

  // Check email - defaults to existing user with password
  http.post(`${API_URL}/api/check-email`, () => {
    return HttpResponse.json({ exists: true, hasPassword: true });
  }),

  // Sign in
  http.post(`${API_URL}/api/auth/sign-in/email`, () => {
    return HttpResponse.json(
      { user: mockUser },
      { headers: { "Set-Cookie": "session=mock-session; Path=/" } }
    );
  }),

  // Sign up
  http.post(`${API_URL}/api/auth/sign-up/email`, () => {
    return HttpResponse.json({ user: mockUser });
  }),

  // Sign out
  http.post(`${API_URL}/api/auth/sign-out`, () => {
    return HttpResponse.json({ success: true });
  }),

  // User org
  http.get(`${API_URL}/api/user/org`, () => {
    return HttpResponse.json(mockOrg);
  }),

  // Invitations
  http.get(`${API_URL}/api/invitations/:id`, ({ params }) => {
    return HttpResponse.json({ ...mockInvitation, id: params.id });
  }),

  // Send verification email
  http.post(`${API_URL}/api/auth/send-verification-email`, () => {
    return HttpResponse.json({ success: true });
  }),
];

// Unauthenticated state handlers
export const unauthenticatedHandlers = [
  http.get(`${API_URL}/api/auth/get-session`, () => {
    return HttpResponse.json(null);
  }),
  http.get(`${API_URL}/api/user/org`, () => {
    return new HttpResponse(null, { status: 401 });
  }),
];
