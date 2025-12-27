import { Resend } from "resend";

// Email configuration
const DEFAULT_FROM_ADDRESS = "Docket <noreply@mail.docketadmin.com>";
const APP_URL = "https://docketadmin.com";

// Shared email styles
const BUTTON_STYLE =
  "display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px;";
const MUTED_TEXT_STYLE = "color: #6b7280; font-size: 14px;";

/**
 * Environment variables required for email sending.
 */
export interface EmailEnv {
  RESEND_API_KEY: string;
  FROM_EMAIL?: string;
}

/**
 * Result of an email send operation.
 */
interface SendResult {
  success: boolean;
  error?: string;
}

/**
 * Sends an email using Resend.
 */
async function sendEmail(
  env: EmailEnv,
  to: string,
  subject: string,
  htmlContent: string,
  textContent: string
): Promise<SendResult> {
  const resend = new Resend(env.RESEND_API_KEY);
  const fromAddress = env.FROM_EMAIL ?? DEFAULT_FROM_ADDRESS;

  const result = await resend.emails.send({
    from: fromAddress,
    to: to,
    subject: subject,
    html: htmlContent,
    text: textContent,
  });

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  return { success: true };
}

// ============================================================================
// Invitation Email
// ============================================================================

export interface SendInvitationInput {
  to: string;
  orgName: string;
  inviterName: string;
  role: string;
  invitationId: string;
}

export async function sendInvitationEmail(
  env: EmailEnv,
  input: SendInvitationInput
): Promise<SendResult> {
  const acceptUrl = `${APP_URL}/auth?invitation=${input.invitationId}`;

  const subject = `You've been invited to join ${input.orgName} on Docket`;

  const htmlContent = `
    <p>${input.inviterName} has invited you to join <strong>${input.orgName}</strong> as a ${input.role}.</p>
    <p>Docket is an AI assistant for law firms that helps with case information, firm procedures, and Clio operations.</p>
    <p><a href="${acceptUrl}" style="${BUTTON_STYLE}">Accept Invitation</a></p>
    <p style="${MUTED_TEXT_STYLE}">This invitation expires in 7 days.</p>
  `;

  const textContent = `${input.inviterName} has invited you to join ${input.orgName} as a ${input.role}.

Accept the invitation: ${acceptUrl}

This invitation expires in 7 days.`;

  return sendEmail(env, input.to, subject, htmlContent, textContent);
}

// ============================================================================
// Password Reset Email
// ============================================================================

export interface SendPasswordResetInput {
  to: string;
  resetUrl: string;
}

export async function sendPasswordResetEmail(
  env: EmailEnv,
  input: SendPasswordResetInput
): Promise<SendResult> {
  const subject = "Reset your Docket password";

  const htmlContent = `
    <p>You requested a password reset for your Docket account.</p>
    <p><a href="${input.resetUrl}" style="${BUTTON_STYLE}">Reset Password</a></p>
    <p style="${MUTED_TEXT_STYLE}">If you didn't request this, you can ignore this email.</p>
    <p style="${MUTED_TEXT_STYLE}">This link expires in 1 hour.</p>
  `;

  const textContent = `You requested a password reset for your Docket account.

Reset your password: ${input.resetUrl}

If you didn't request this, you can ignore this email. This link expires in 1 hour.`;

  return sendEmail(env, input.to, subject, htmlContent, textContent);
}

// ============================================================================
// Email Verification
// ============================================================================

export interface SendVerificationInput {
  to: string;
  verificationUrl: string;
}

export async function sendVerificationEmail(
  env: EmailEnv,
  input: SendVerificationInput
): Promise<SendResult> {
  const subject = "Verify your Docket email";

  const htmlContent = `
    <p>Welcome to Docket! Please verify your email address.</p>
    <p><a href="${input.verificationUrl}" style="${BUTTON_STYLE}">Verify Email</a></p>
    <p style="${MUTED_TEXT_STYLE}">If you didn't create a Docket account, you can ignore this email.</p>
  `;

  const textContent = `Welcome to Docket! Please verify your email address.

Verify your email: ${input.verificationUrl}

If you didn't create a Docket account, you can ignore this email.`;

  return sendEmail(env, input.to, subject, htmlContent, textContent);
}
