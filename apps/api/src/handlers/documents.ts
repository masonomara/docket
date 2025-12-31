import type { AdminContext } from "../lib/session";
import { createLogger, generateRequestId } from "../lib/logger";
import type { Env } from "../types/env";
import {
  listOrgContext,
  uploadOrgContext,
  deleteOrgContext,
  getOrgContextDocument,
} from "../services/org-context";
import { errors, errorResponse } from "../lib/errors";

/**
 * GET /org/documents
 * Returns all documents for the organization.
 */
export async function handleGetDocuments(
  _request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  const documents = await listOrgContext(env, ctx.orgId);
  return Response.json(documents);
}

/**
 * POST /org/documents
 * Upload a new document to the organization's knowledge base.
 */
export async function handleUploadDocument(
  request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  const log = createLogger({
    requestId: generateRequestId(),
    handler: "uploadDocument",
    orgId: ctx.orgId,
    userId: ctx.user.id,
  });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(400, "Invalid form data", "INVALID_REQUEST");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errors.missingField("File");
  }

  log.info("Upload started", { filename: file.name, size: file.size });

  // Process the upload
  const fileContents = await file.arrayBuffer();
  const result = await uploadOrgContext(
    env,
    ctx.orgId,
    file.name,
    file.type,
    fileContents,
    ctx.user.id,
    log
  );

  if (!result.success) {
    log.error("Upload failed", { error: result.error });
    return errorResponse(400, result.error || "Upload failed", "INVALID_REQUEST");
  }

  log.info("Upload complete", {
    fileId: result.fileId,
    chunksCreated: result.chunksCreated,
  });

  // Return the newly created document
  const document = await getOrgContextDocument(env, ctx.orgId, result.fileId!);
  return Response.json(document, { status: 201 });
}

/**
 * DELETE /org/documents/:documentId
 * Remove a document from the organization's knowledge base.
 */
export async function handleDeleteDocument(
  _request: Request,
  env: Env,
  ctx: AdminContext,
  documentId: string
): Promise<Response> {
  const existingDocument = await getOrgContextDocument(env, ctx.orgId, documentId);
  if (!existingDocument) {
    return errors.notFound("Document");
  }

  const result = await deleteOrgContext(env, ctx.orgId, documentId);
  if (!result.success) {
    return errors.internal(result.error || "Delete failed");
  }

  return Response.json({ success: true });
}
